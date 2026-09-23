import { createHash } from "node:crypto";

// Reserve part of the existing aggregate parser budget, not an extra budget
// for every environment. The shared pool and each worker get one partition.
export const compilerCacheBytes = 64 * 1024 * 1024;
export const compilerPayloadBytes = 8 * 1024 * 1024;
export const compilerPayloadMinimumBytes = 32 * 1024;
export const compilerPayloadProtocol = "mincho-compiler-source-v1";

export interface CompilerPayloadScope {
  readonly environment: string;
  readonly generation: number;
  readonly context: string;
}

export interface CompilerPayloadReference extends CompilerPayloadScope {
  readonly id: string;
  readonly bytes: number;
}

export interface CompilerSourcePayload {
  reference: CompilerPayloadReference;

  /** First use stays inline, so a non-reused source never adds an RPC. */
  inline: boolean;
}

interface Entry {
  reference: CompilerPayloadReference;
  value: string;
  cost: number;
  misses: number;
  directUses: number;
}

export function compilerPayloadContext(value: unknown): string {
  return createHash("sha256")
    .update(compilerPayloadProtocol)
    .update(JSON.stringify(value))
    .digest("hex");
}

function address(scope: CompilerPayloadScope, value: string): string {
  return (
    createHash("sha256")
      .update(
        JSON.stringify([scope.environment, scope.generation, scope.context])
      )
      .update("\0")
      // Structured clone preserves UTF-16 code units, including lone surrogates.
      // UTF-8 hashing would alias different lone surrogates with U+FFFD.
      .update(value, "utf16le")
      .digest("hex")
  );
}

export function sameCompilerPayload(
  left: CompilerPayloadReference,
  right: CompilerPayloadReference
): boolean {
  return (
    left.id === right.id &&
    left.bytes === right.bytes &&
    left.environment === right.environment &&
    left.generation === right.generation &&
    left.context === right.context
  );
}

/** Content-addressed strings only; no AST, provider, or mutable option objects. */
export class CompilerPayloadCache {
  private readonly entries = new Map<string, Entry>();
  private size = 0;

  constructor(
    readonly maxBytes: number,
    private readonly maxEntries = 128
  ) {}

  get bytes(): number {
    return this.size;
  }

  get count(): number {
    return this.entries.size;
  }

  prepare(
    scope: CompilerPayloadScope,
    value: string
  ): CompilerSourcePayload | undefined {
    // UTF-8 is at most three bytes per UTF-16 code unit. Avoid hashing short DTOs.
    if (value.length < compilerPayloadMinimumBytes / 3) return;

    const bytes = Buffer.byteLength(value);
    if (bytes < compilerPayloadMinimumBytes) return;

    const cost =
      value.length * 2 +
      scope.environment.length * 2 +
      scope.context.length * 2 +
      160;
    if (cost > this.maxBytes || this.maxEntries < 1) return;

    const reference = { ...scope, id: address(scope, value), bytes };

    if (this.get(reference) !== undefined) {
      const entry = this.entries.get(reference.id)!;

      if (entry.directUses > 0) {
        entry.directUses--;

        return { reference, inline: true };
      }

      return { reference, inline: false };
    }

    this.store(reference, value, cost);

    return { reference, inline: true };
  }

  get(reference: CompilerPayloadReference): string | undefined {
    const entry = this.entries.get(reference.id);
    if (!entry || !sameCompilerPayload(entry.reference, reference)) return;

    this.entries.delete(reference.id);
    this.entries.set(reference.id, entry);

    return entry.value;
  }

  accept(reference: CompilerPayloadReference, value: string): void {
    // A hash/reference alone never establishes that this worker has the bytes.
    if (
      Buffer.byteLength(value) !== reference.bytes ||
      address(reference, value) !== reference.id
    )
      throw new Error(
        "Compiler source payload did not match its content address"
      );

    const cost =
      value.length * 2 +
      reference.environment.length * 2 +
      reference.context.length * 2 +
      160;

    if (cost <= this.maxBytes && this.maxEntries > 0)
      this.store(reference, value, cost);
  }

  reset(environment: string, generation?: number): void {
    for (const [id, entry] of this.entries)
      if (
        entry.reference.environment === environment &&
        (generation === undefined || entry.reference.generation !== generation)
      ) {
        this.entries.delete(id);
        this.size -= entry.cost;
      }
  }

  feedback(reference: CompilerPayloadReference, hit: boolean): void {
    const entry = this.entries.get(reference.id);
    if (!entry || !sameCompilerPayload(entry.reference, reference)) return;

    if (hit) {
      entry.misses = 0;
      entry.directUses = 0;
    } else {
      entry.misses = Math.min(5, entry.misses + 1);

      // Repeated dispatch to cold/evicted workers should not add a round trip
      // to every task. Seed inline for a bounded interval before probing again.
      if (entry.misses > 1) entry.directUses = 2 ** (entry.misses - 1);
    }
  }

  private store(
    reference: CompilerPayloadReference,
    value: string,
    cost: number
  ): void {
    const previous = this.entries.get(reference.id);

    if (previous) {
      this.entries.delete(reference.id);
      this.size -= previous.cost;
    }

    this.entries.set(reference.id, {
      reference: { ...reference },
      value,
      cost,
      misses: 0,
      directUses: 0
    });
    this.size += cost;

    while (this.entries.size > this.maxEntries || this.size > this.maxBytes) {
      const [id, entry] = this.entries.entries().next().value!;
      this.entries.delete(id);
      this.size -= entry.cost;
    }
  }
}
