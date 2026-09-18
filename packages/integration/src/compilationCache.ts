import { InternalSourceAstCache } from "@mincho-js/babel";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { recordCompilationDiagnostic } from "./diagnostics.js";

export interface CacheEntry<T> {
  readonly value: T;
  readonly bytes: number;
  readonly dependencies: readonly string[];
  readonly valid: () => Promise<boolean>;
}

/** One environment owns this cache. No failures or stale writes survive a generation. */
export class CompilationCache {
  readonly parser = new InternalSourceAstCache((hit) =>
    recordCompilationDiagnostic(hit ? "parse-cache-hit" : "parse-cache-miss")
  );
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private generation = 0;
  private bytes = 0;

  constructor(
    private readonly maxEntries = 512,
    private readonly maxBytes = 64 * 1024 * 1024
  ) {}

  begin(): void {
    this.generation++;
    this.pending.clear();
  }

  clear(): void {
    this.begin();
    this.entries.clear();
    this.parser.clear();
    this.bytes = 0;
  }

  invalidate(file: string): void {
    this.begin();

    for (const [key, entry] of this.entries)
      if (entry.dependencies.includes(file)) this.remove(key);
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

      return pending as Promise<T>;
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

    if (entry) this.bytes -= entry.bytes;

    this.entries.delete(key);
  }
}

export function cacheDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function fileDigest(file: string): Promise<string | null> {
  try {
    return cacheDigest(await readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EISDIR")
      return `directory:${cacheDigest(JSON.stringify((await readdir(file)).sort()))}`;
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR"
    )
      return null;

    throw error;
  }
}

export function configurationFiles(files: Iterable<string>): string[] {
  const inputs = [...files];
  const sourceDirectories = new Set(inputs.map((file) => dirname(file)));
  const directories = new Set<string>();

  for (const file of inputs)
    for (
      let directory = dirname(file);
      !directories.has(directory);
      directory = dirname(directory)
    ) {
      directories.add(directory);

      if (directory === dirname(directory)) break;
    }

  return [...directories].flatMap((directory) => [
    ...(sourceDirectories.has(directory) ? [directory] : []),
    ...[
      "package.json",
      "tsconfig.json",
      ".pnp.cjs",
      ".pnp.data.json",
      "yarn.lock",
      "package-lock.json",
      "pnpm-lock.yaml",
      ".babelrc",
      ".babelrc.json",
      ".babelrc.js",
      ".babelrc.cjs",
      "babel.config.js",
      "babel.config.cjs",
      "babel.config.json"
    ].map((name) => join(directory, name))
  ]);
}

export async function fingerprintFiles(
  files: Iterable<string>
): Promise<Map<string, string | null>> {
  return new Map(
    await Promise.all(
      [...new Set(files)].map(
        async (file) => [file, await fileDigest(file)] as const
      )
    )
  );
}

export async function unchangedFiles(
  fingerprints: ReadonlyMap<string, string | null>
): Promise<boolean> {
  return (
    await Promise.all(
      [...fingerprints].map(
        async ([file, digest]) => (await fileDigest(file)) === digest
      )
    )
  ).every(Boolean);
}

/** Unknown configuration inputs disable reuse without changing compilation behavior. */
export async function hasExternalBabelConfiguration(
  files: ReadonlyMap<string, string | null>
): Promise<boolean> {
  for (const [file, value] of files) {
    if (value === null) continue;
    if (/(?:\.babelrc(?:\.|$)|babel\.config\.)/.test(file)) return true;

    if (file.endsWith("/package.json")) {
      try {
        if (JSON.parse(await readFile(file, "utf8")).babel) return true;
      } catch {
        return true;
      }
    }
  }

  return false;
}
