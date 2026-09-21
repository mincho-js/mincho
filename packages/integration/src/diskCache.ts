import { internalResolveFromModule as resolveFromModule } from "@mincho-js/babel";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "node:v8";
import { recordCompilationDiagnostic } from "./diagnostics.js";
import { CoalescedAtomicWriter } from "./coalescedWriter.js";

export interface PersistentManifest {
  readonly fingerprints: readonly (readonly [string, string | null])[];
  readonly semanticFiles?: readonly string[];
}

export interface PersistentEntry {
  readonly value: unknown;
  readonly owner?: string;
  readonly dependencies: readonly string[];
  readonly bytes: number;
  readonly manifest: PersistentManifest;
}

const format = "mincho-compilation-v2";

const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

let compilerIdentity: Promise<string> | undefined;

/** Include built chunks as well as entrypoints; package versions alone miss local edits. */
export function getCompilerIdentity(): Promise<string> {
  return (compilerIdentity ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: the CJS declaration build checks import.meta as well.
    const moduleUrl = import.meta.url;
    const entries = [
      fileURLToPath(moduleUrl),
      ...[
        "@mincho-js/integration",
        "@mincho-js/babel",
        "@mincho-js/css",
        "@babel/core",
        "esbuild",
        "@vanilla-extract/integration",
        "@vanilla-extract/css"
      ].map((name) => resolveFromModule(moduleUrl, name))
    ];

    entries.push(
      resolveFromModule(
        resolveFromModule(moduleUrl, "@mincho-js/css"),
        "@mincho-js/transform-to-vanilla"
      )
    );

    const hash = createHash("sha256").update(
      JSON.stringify([
        format,
        process.versions,
        process.platform,
        process.arch,
        process.execArgv
      ])
    );

    const seen = new Set<string>();

    for (const entry of entries) {
      const directory = dirname(entry);

      for (const name of (await readdir(directory)).sort()) {
        if (
          !/\.(?:[cm]?js|ts|json)$/.test(name) ||
          name.endsWith(".d.ts") ||
          name.endsWith(".test.ts")
        )
          continue;

        const file = join(directory, name);
        if (seen.has(file)) continue;

        seen.add(file);
        hash.update(file).update(await readFile(file));
      }
    }

    return hash.digest("hex");
  })());
}

export class CompilationDiskCache {
  private readonly writes = new Set<Promise<void>>();
  private readonly writer: CoalescedAtomicWriter;
  private disabled = false;
  private ready?: Promise<void>;

  constructor(
    readonly directory: string,
    private readonly namespace: string | Promise<string>,
    private readonly maxBytes = 256 * 1024 * 1024,
    readonly minimumCost = 0
  ) {
    this.writer = new CoalescedAtomicWriter();

    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new TypeError("cache.maxBytes must be a positive integer");

    void Promise.resolve(namespace).catch(() => {
      this.disabled = true;
    });
  }

  private async path(key: string): Promise<string> {
    return join(
      this.directory,
      `${digest(`${await this.namespace}:${key}`)}.mincho-cache`
    );
  }

  prepare(): Promise<void> {
    return (this.ready ??= mkdir(this.directory, { recursive: true }).then(
      () => undefined,
      () => {
        this.disabled = true;
      }
    ));
  }

  async get(key: string): Promise<PersistentEntry | undefined> {
    if (this.disabled) return;

    try {
      const file = await this.path(key);
      const info = await stat(file);
      if (info.size > this.maxBytes) return;

      const bytes = await readFile(file);
      const payload = bytes.subarray(65);
      if (
        bytes[64] !== 10 ||
        bytes.subarray(0, 64).toString() !== digest(payload)
      )
        return;

      const record = deserialize(payload) as {
        format: string;
        namespace: string;
        key: string;
        entry: PersistentEntry;
      };
      if (
        record.format !== format ||
        record.namespace !== (await this.namespace) ||
        record.key !== key ||
        !validEntry(record.entry)
      )
        return;

      const now = new Date();
      await utimes(file, now, now).catch(() => undefined);
      recordCompilationDiagnostic("disk-cache-hit", {
        key,
        bytes: bytes.length
      });

      return record.entry;
    } catch {
      recordCompilationDiagnostic("disk-cache-miss", { key });

      return;
    }
  }

  put(
    key: string,
    entry: PersistentEntry,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    if (this.disabled) return Promise.resolve();

    const operation = (async () => {
      try {
        const namespace = await this.namespace;

        if (!isCurrent()) {
          recordCompilationDiagnostic("disk-cache-write-stale", { key });

          return;
        }

        if (this.disabled) return;

        await this.writer.write(
          await this.path(key),
          () => {
            const payload = serialize({ format, namespace, key, entry });
            if (payload.length + 65 > this.maxBytes) return;

            return Buffer.concat([
              Buffer.from(digest(payload) + "\n"),
              payload
            ]);
          },
          {
            isCurrent: () => !this.disabled && isCurrent(),

            observe: ({ kind, bytes }) =>
              recordCompilationDiagnostic(
                kind === "written"
                  ? "disk-cache-write"
                  : `disk-cache-write-${kind}`,
                { key, bytes }
              )
          }
        );
      } catch (error) {
        // A read-only filesystem or incompatible payload never breaks compilation.
        recordCompilationDiagnostic("disk-cache-bypass", {
          reason: String(error)
        });

        if (
          ["EACCES", "EROFS", "ENOSPC"].includes(
            (error as NodeJS.ErrnoException).code ?? ""
          )
        )
          this.disabled = true;
      }
    })();

    this.writes.add(operation);
    void operation.finally(() => this.writes.delete(operation));

    return operation;
  }

  async flush(): Promise<void> {
    while (this.writes.size) await Promise.all([...this.writes]);

    await this.writer.flush();

    if (this.disabled) return;

    try {
      const files: { file: string; bytes: number; used: number }[] = [];

      for (const name of await readdir(this.directory)) {
        if (extname(name) !== ".mincho-cache") continue;

        const file = join(this.directory, name);
        const info = await stat(file).catch(() => undefined);

        if (info?.isFile())
          files.push({ file, bytes: info.size, used: info.mtimeMs });
      }

      let bytes = files.reduce((total, file) => total + file.bytes, 0);

      for (const file of files.sort((a, b) => a.used - b.used)) {
        if (bytes <= this.maxBytes) break;

        await rm(file.file, { force: true });
        bytes -= file.bytes;
      }
    } catch {
      // Another process can evict an entry at any point; the reader treats it as a miss.
    }
  }
}

function validEntry(entry: PersistentEntry): boolean {
  return (
    !!entry &&
    Number.isFinite(entry.bytes) &&
    entry.bytes >= 0 &&
    (entry.owner === undefined || typeof entry.owner === "string") &&
    Array.isArray(entry.dependencies) &&
    entry.dependencies.every((file) => typeof file === "string") &&
    (entry.manifest?.semanticFiles === undefined ||
      (Array.isArray(entry.manifest.semanticFiles) &&
        entry.manifest.semanticFiles.every(
          (file) => typeof file === "string"
        ))) &&
    Array.isArray(entry.manifest?.fingerprints) &&
    entry.manifest.fingerprints.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        (pair[1] === null || typeof pair[1] === "string")
    )
  );
}
