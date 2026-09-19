import { InternalSourceAstCache } from "@mincho-js/babel";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  CompilationInputs,
  configurationFiles,
  fingerprintFiles,
  unchangedFiles,
  hasExternalBabelConfiguration
} from "./compilationInputs.js";
import {
  bindCompilationDiagnostics,
  recordCompilationDiagnostic
} from "./diagnostics.js";

export {
  cacheDigest,
  fileDigest,
  configurationFiles,
  fingerprintFiles,
  unchangedFiles,
  hasExternalBabelConfiguration
} from "./compilationInputs.js";

export interface CacheEntry<T> {
  readonly owner?: string;
  readonly value: T;
  readonly bytes: number;
  readonly dependencies: readonly string[];
  readonly valid: () => Promise<boolean>;
  readonly manifest?: {
    readonly fingerprints: readonly (readonly [string, string | null])[];
    readonly semanticFiles?: readonly string[];
  };
}

/** One environment owns this cache. No failures or stale writes survive a generation. */
export class CompilationCache {
  readonly parser: InternalSourceAstCache;
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly dependencyEntries = new Map<string, Set<string>>();
  private readonly requestInputs = new AsyncLocalStorage<CompilationInputs>();
  private readonly inputWrites = new WeakMap<
    CompilationInputs,
    Map<string, CacheEntry<unknown>>
  >();
  private readonly writeInputs = new WeakMap<
    CacheEntry<unknown>,
    CompilationInputs
  >();
  private buildInputs?: CompilationInputs;
  private generation = 0;
  private bytes = 0;

  constructor(
    private readonly maxEntries = 512,
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly sharedParser?: InternalSourceAstCache
  ) {
    this.parser =
      sharedParser ??
      new InternalSourceAstCache(
        (hit, kind = "parse") =>
          recordCompilationDiagnostic(`${kind}-cache-${hit ? "hit" : "miss"}`),
        maxEntries,
        maxBytes
      );
  }

  begin(reader?: (file: string) => Promise<Uint8Array>): void {
    this.buildInputs?.cancel();
    this.buildInputs = new CompilationInputs(reader);
    this.generation++;
    this.pending.clear();
  }

  /** Builds validate once at their publication boundary. */
  async end(): Promise<void> {
    const inputs = this.buildInputs;
    if (!inputs) return;

    try {
      await this.validateInputs(inputs);
    } catch (error) {
      this.rollbackInputs(inputs);

      throw error;
    } finally {
      this.inputWrites.delete(inputs);
      inputs.close();

      if (this.buildInputs === inputs) this.buildInputs = undefined;
    }
  }

  /** Standalone integrations get a fresh snapshot on every top-level call. */
  async withInputs<T>(operation: () => Promise<T>): Promise<T> {
    if (this.inputs) return operation();

    const inputs = new CompilationInputs();

    return this.requestInputs.run(inputs, async () => {
      try {
        const result = await operation();
        await this.validateInputs(inputs);

        return result;
      } catch (error) {
        this.rollbackInputs(inputs);

        throw error;
      } finally {
        this.inputWrites.delete(inputs);
        inputs.close();
      }
    });
  }

  private get inputs(): CompilationInputs | undefined {
    const request = this.requestInputs.getStore();

    return request?.active ? request : this.buildInputs;
  }

  get hasActiveInputs(): boolean {
    return this.inputs !== undefined;
  }

  /** Native esbuild callbacks can run in an older service's async context. */
  bindInputs<A extends unknown[], T>(
    operation: (...args: A) => T
  ): (...args: A) => T {
    const inputs = this.inputs;
    const observed = bindCompilationDiagnostics(operation);

    return inputs
      ? (...args) => this.requestInputs.run(inputs, () => observed(...args))
      : observed;
  }

  configurationFiles(files: Iterable<string>): string[] {
    return this.inputs?.configurationFiles(files) ?? configurationFiles(files);
  }

  fingerprint(files: Iterable<string>): Promise<Map<string, string | null>> {
    return this.inputs?.fingerprint(files) ?? fingerprintFiles(files);
  }

  unchanged(files: ReadonlyMap<string, string | null>): Promise<boolean> {
    return this.inputs?.unchanged(files) ?? unchangedFiles(files);
  }

  hasExternalBabelConfiguration(
    files: ReadonlyMap<string, string | null>
  ): Promise<boolean> {
    return (
      this.inputs?.hasExternalBabelConfiguration(files) ??
      hasExternalBabelConfiguration(files)
    );
  }

  async readFile(file: string): Promise<Uint8Array> {
    return (this.inputs ?? new CompilationInputs()).readFile(file);
  }

  private async validateInputs(inputs: CompilationInputs): Promise<void> {
    const changed = await inputs.validate();

    // Native bundlers can create output directories during a build. Such a
    // directory change invalidates reuse, but is not a changed source file.
    for (const file of [...changed.files, ...changed.directories])
      this.invalidateEntries(file);

    if (changed.files.length)
      throw new Error(
        "Mincho inputs changed during compilation: " + changed.files.join(", ")
      );
  }

  private rollbackInputs(inputs: CompilationInputs): void {
    for (const [key, entry] of this.inputWrites.get(inputs) ?? [])
      if (this.entries.get(key) === entry) this.remove(key);
  }

  clear(): void {
    this.buildInputs?.cancel();
    this.buildInputs = undefined;
    this.generation++;
    this.pending.clear();

    for (const key of this.entries.keys()) this.remove(key);

    this.dependencyEntries.clear();
    if (!this.sharedParser) this.parser.clear();
    this.bytes = 0;
  }

  invalidate(file: string): void {
    this.generation++;
    this.pending.clear();
    this.invalidateEntries(file);
  }

  private invalidateEntries(file: string): void {
    const pending = [file];
    const visited = new Set<string>();

    while (pending.length) {
      const dependency = pending.pop()!;
      if (visited.has(dependency)) continue;

      visited.add(dependency);

      for (const key of [...(this.dependencyEntries.get(dependency) ?? [])]) {
        const entry = this.entries.get(key);

        // Retain semantic entries until their provider has supplied the changed export.
        if (entry?.manifest?.semanticFiles?.includes(dependency)) continue;
        if (entry?.owner) pending.push(entry.owner);

        this.remove(key);
      }
    }
  }

  async run<T>(
    key: string,
    create: () => Promise<CacheEntry<T>>,
    validate?: (value: T) => Promise<boolean>
  ): Promise<T> {
    const generation = this.generation;
    const pending = this.pending.get(key);

    if (pending) {
      recordCompilationDiagnostic("cache-pending", { key });

      const value = await (pending as Promise<T>);

      if (generation !== this.generation) {
        try {
          if (!validate || (await validate(value))) return value;
        } catch {
          /* Retry through the caller's provider without publishing stale work. */
        }

        return (await create()).value;
      }

      // A concurrent caller owns its input snapshot and resolver environment.
      // Reuse the completed entry only after both normal validators pass.
      if (this.pending.get(key) === pending) this.pending.delete(key);

      return this.run(key, create, validate);
    }

    const operation = (async () => {
      const previous = this.entries.get(key) as CacheEntry<T> | undefined;

      if (previous) {
        let valid = false;

        try {
          valid =
            (await previous.valid()) &&
            (!validate || (await validate(previous.value)));
        } catch {
          /* Resolution failures must take the normal compilation/error path. */
        }

        if (valid && generation === this.generation) {
          this.entries.delete(key);
          this.entries.set(key, previous);
          recordCompilationDiagnostic("cache-hit", { key });

          return previous.value;
        }

        if (this.entries.get(key) === previous) this.remove(key);
        if (previous.manifest?.semanticFiles?.length && previous.owner)
          this.invalidateEntries(previous.owner);

        recordCompilationDiagnostic("cache-invalidated", { key });
      } else recordCompilationDiagnostic("cache-miss", { key });

      const entry = await create();

      if (
        generation === this.generation &&
        entry.bytes <= this.maxBytes &&
        this.maxEntries > 0
      ) {
        this.remove(key);
        this.entries.set(key, entry);

        const inputs = this.inputs;

        if (inputs) {
          const writes = this.inputWrites.get(inputs) ?? new Map();
          writes.set(key, entry);
          this.inputWrites.set(inputs, writes);
          this.writeInputs.set(entry, inputs);
        }

        for (const file of entry.dependencies) {
          const keys = this.dependencyEntries.get(file) ?? new Set<string>();
          keys.add(key);
          this.dependencyEntries.set(file, keys);
        }

        this.bytes += entry.bytes;

        while (
          this.entries.size > this.maxEntries ||
          this.bytes > this.maxBytes
        )
          this.remove(this.entries.keys().next().value!);
      }

      return entry.value;
    })();

    this.pending.set(key, operation);

    try {
      return await operation;
    } finally {
      if (this.pending.get(key) === operation) this.pending.delete(key);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);

    if (entry) {
      const inputs = this.writeInputs.get(entry);

      if (inputs) this.inputWrites.get(inputs)?.delete(key);

      this.writeInputs.delete(entry);
      this.bytes -= entry.bytes;

      for (const file of entry.dependencies) {
        const keys = this.dependencyEntries.get(file);
        keys?.delete(key);

        if (!keys?.size) this.dependencyEntries.delete(file);
      }
    }

    this.entries.delete(key);
  }
}
