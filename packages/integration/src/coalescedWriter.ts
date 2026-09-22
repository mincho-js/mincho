import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getCompilationIoPool, type CompilationIoPool } from "./ioPool.js";

export type AtomicWriteResult = "written" | "unchanged" | "stale" | "skipped";

export interface AtomicWriteEvent {
  kind: AtomicWriteResult | "coalesced" | "failed";
  path: string;
  bytes?: number;
}

interface WriteOptions {
  isCurrent?: () => boolean;
  observe?: (event: AtomicWriteEvent) => void;
}

interface PendingWrite {
  bytes: () =>
    | string
    | Uint8Array
    | undefined
    | Promise<string | Uint8Array | undefined>;
  options: WriteOptions;
  io: CompilationIoPool;
  promise: Promise<AtomicWriteResult>;

  resolve(result: AtomicWriteResult): void;

  reject(error: unknown): void;
}

interface PathWrites {
  pending?: PendingWrite;
  drain: Promise<void>;
}

// Concurrent cache/diagnostic owners can target the same file. Coordinate only
// while writes are in flight; completed paths and content are never retained.
const activePaths = new Map<string, PathWrites>();

async function sameContents(path: string, bytes: Buffer): Promise<boolean> {
  const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;

    throw error;
  });
  if (!file) return false;

  try {
    if ((await file.stat()).size !== bytes.length) return false;

    // Compare the actual file, with bounded scratch space. A previous digest
    // alone would miss external replacement, corruption, and disk eviction.
    const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, bytes.length));

    for (let offset = 0; offset < bytes.length; ) {
      const { bytesRead } = await file.read(
        scratch,
        0,
        Math.min(scratch.length, bytes.length - offset),
        offset
      );
      if (
        !bytesRead ||
        !scratch
          .subarray(0, bytesRead)
          .equals(bytes.subarray(offset, offset + bytesRead))
      )
        return false;

      offset += bytesRead;
    }

    return (await file.stat()).size === bytes.length;
  } finally {
    await file.close();
  }
}

/** Per-path FIFO publication, with a separate drain boundary for each owner. */
export class CoalescedAtomicWriter {
  private readonly pending = new Set<Promise<AtomicWriteResult>>();

  constructor(
    private readonly io: CompilationIoPool = getCompilationIoPool()
  ) {}

  write(
    path: string,
    bytes: PendingWrite["bytes"],
    options: WriteOptions = {}
  ): Promise<AtomicWriteResult> {
    if (options.isCurrent && !options.isCurrent()) {
      options.observe?.({ kind: "stale", path });

      return Promise.resolve("stale");
    }

    const bound = {
      ...options,
      observe: options.observe && AsyncResource.bind(options.observe)
    };

    let state = activePaths.get(path);

    if (state?.pending) {
      // A caller waiting on an older value also waits for its replacement.
      state.pending.bytes = bytes;
      state.pending.options = bound;
      // The latest submitter's pool controls publication. Writers sharing a
      // path should share a pool if they need the same concurrency limit.
      state.pending.io = this.io;
      bound.observe?.({ kind: "coalesced", path });

      return this.track(state.pending.promise);
    }

    let resolve!: PendingWrite["resolve"];
    let reject!: PendingWrite["reject"];
    const promise = new Promise<AtomicWriteResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });

    const pending = {
      bytes,
      options: bound,
      io: this.io,
      promise,
      resolve,
      reject
    };

    if (state) state.pending = pending;
    else {
      state = { pending, drain: Promise.resolve() };
      activePaths.set(path, state);

      const current = state;

      // Coalesce before serialization as well as before filesystem work.
      state.drain = Promise.resolve().then(() => this.drain(path, current));
    }

    return this.track(promise);
  }

  async flush(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track(
    promise: Promise<AtomicWriteResult>
  ): Promise<AtomicWriteResult> {
    if (!this.pending.has(promise)) {
      this.pending.add(promise);
      void promise.then(
        () => this.pending.delete(promise),
        () => this.pending.delete(promise)
      );
    }

    return promise;
  }

  private async drain(path: string, state: PathWrites): Promise<void> {
    try {
      while (state.pending) {
        const request = state.pending;
        state.pending = undefined;

        const current = () =>
          (!request.options.isCurrent || request.options.isCurrent()) &&
          // A queued, valid successor owns the next publication for this path.
          (!state.pending ||
            Boolean(
              state.pending.options.isCurrent &&
              !state.pending.options.isCurrent()
            ));

        try {
          const result = await this.publish(path, request, current);
          request.options.observe?.({
            kind: result.kind,
            path,
            bytes: result.bytes
          });
          request.resolve(result.kind);
        } catch (error) {
          request.options.observe?.({ kind: "failed", path });
          request.reject(error);
        }
      }
    } finally {
      activePaths.delete(path);
    }
  }

  private async publish(
    path: string,
    request: PendingWrite,
    current: () => boolean
  ): Promise<{ kind: AtomicWriteResult; bytes?: number }> {
    if (!current()) return { kind: "stale" };

    const value = await request.bytes();
    if (value === undefined) return { kind: "skipped" };

    const bytes = Buffer.isBuffer(value)
      ? value
      : typeof value === "string"
        ? Buffer.from(value)
        : Buffer.from(value);
    if (!current()) return { kind: "stale", bytes: bytes.length };

    return request.io.run(async () => {
      let temporary: string | undefined;

      try {
        if (!current()) return { kind: "stale", bytes: bytes.length };

        await mkdir(dirname(path), { recursive: true });

        const identical = await sameContents(path, bytes);
        if (!current()) return { kind: "stale", bytes: bytes.length };
        if (identical) return { kind: "unchanged", bytes: bytes.length };

        temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, bytes, { flag: "wx" });

        // No stale or superseded value may be published after awaited I/O.
        if (!current()) return { kind: "stale", bytes: bytes.length };

        await rename(temporary, path);
        temporary = undefined;

        return { kind: "written", bytes: bytes.length };
      } finally {
        if (temporary)
          await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  }
}
