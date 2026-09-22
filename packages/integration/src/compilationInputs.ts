import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { recordCompilationDiagnostic } from "./diagnostics.js";
import { getCompilationIoPool, type CompilationIoPool } from "./ioPool.js";

type Input = { digest: string | null; bytes?: Uint8Array };

type Reader = (file: string) => Promise<Uint8Array>;

/**
 * An input snapshot belongs to one build/request, never to a dev server's
 * lifetime. Content checks, including absent configuration files, are shared.
 */
export class CompilationInputs {
  private readonly inputs = new Map<string, Promise<Input>>();
  private readonly configurations = new Map<string, readonly string[]>();
  private readonly directories = new Set<string>();
  private readonly packages = new Map<string, Promise<boolean>>();
  private cancelled = false;
  private closed = false;

  get active(): boolean {
    return !this.closed;
  }

  close(): void {
    this.closed = true;
    this.inputs.clear();
    this.configurations.clear();
    this.directories.clear();
    this.packages.clear();
  }

  constructor(
    private readonly reader: Reader = readFile,
    private readonly io: CompilationIoPool = getCompilationIoPool()
  ) {}

  cancel(): void {
    this.cancelled = true;
  }

  private input(file: string): Promise<Input> {
    let pending = this.inputs.get(file);

    if (!pending) {
      recordCompilationDiagnostic("input-read", { file });
      pending = this.io.run(() =>
        readInput(file, this.directories.has(file) ? readFile : this.reader)
      );
      this.inputs.set(file, pending);
      void pending.catch(() => {
        if (this.inputs.get(file) === pending) this.inputs.delete(file);
      });
    } else recordCompilationDiagnostic("input-reuse", { file });

    return pending;
  }

  async readFile(file: string): Promise<Uint8Array> {
    const input = await this.input(file);
    if (input.bytes) return input.bytes;

    // Preserve the native error, including the original path and error code.
    return this.io.run(() => this.reader(file));
  }

  async fingerprint(
    files: Iterable<string>
  ): Promise<Map<string, string | null>> {
    return new Map(
      await Promise.all(
        [...new Set(files)].map(
          async (file) => [file, (await this.input(file)).digest] as const
        )
      )
    );
  }

  async unchanged(files: ReadonlyMap<string, string | null>): Promise<boolean> {
    for (const [file, digest] of files)
      if (digest?.startsWith("directory:")) this.directories.add(file);

    const current = await this.fingerprint(files.keys());

    return [...files].every(([file, digest]) => current.get(file) === digest);
  }

  configurationFiles(files: Iterable<string>): string[] {
    const result = new Set<string>();

    for (const file of files) {
      const directory = dirname(file);
      this.directories.add(directory);

      let paths = this.configurations.get(directory);

      if (!paths) {
        paths = configurationFiles([file]);
        this.configurations.set(directory, paths);
      }

      for (const path of paths) result.add(path);
    }

    return [...result];
  }

  async hasExternalBabelConfiguration(
    files: ReadonlyMap<string, string | null>
  ): Promise<boolean> {
    for (const [file, value] of files) {
      if (value === null) continue;
      if (/(?:\.babelrc(?:\.|$)|\.babelignore$|babel\.config\.)/.test(file))
        return true;
      if (!file.endsWith("/package.json")) continue;

      let pending = this.packages.get(file);

      if (!pending) {
        pending = this.readFile(file).then(
          (bytes) => {
            try {
              return Boolean(
                JSON.parse(Buffer.from(bytes).toString("utf8")).babel
              );
            } catch {
              return true;
            }
          },
          () => true
        );
        this.packages.set(file, pending);
      }

      if (await pending) return true;
    }

    return false;
  }

  /** Check real inputs again before accepting results, even with a custom reader. */
  async validate(): Promise<{ files: string[]; directories: string[] }> {
    const files: string[] = [];
    const directories: string[] = [];
    await Promise.all(
      [...this.inputs].map(async ([file, pending]) => {
        const previous = await pending;
        recordCompilationDiagnostic("input-validate", { file });

        const current = await fileDigest(file, this.io);

        if (current !== previous.digest)
          (previous.digest?.startsWith("directory:")
            ? directories
            : files
          ).push(file);
      })
    );

    if (this.cancelled)
      throw new Error(
        "Mincho compilation inputs were invalidated during compilation."
      );

    return { files: files.sort(), directories: directories.sort() };
  }
}

export function cacheDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readInput(file: string, reader: Reader): Promise<Input> {
  try {
    const bytes = await reader(file);
    recordCompilationDiagnostic("input-hash", {
      file,
      bytes: bytes.byteLength
    });

    return { bytes, digest: cacheDigest(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EISDIR")
      return {
        digest:
          "directory:" +
          cacheDigest(JSON.stringify((await readdir(file)).sort()))
      };
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR"
    )
      return { digest: null };

    throw error;
  }
}

export async function fileDigest(
  file: string,
  io = getCompilationIoPool()
): Promise<string | null> {
  return (await io.run(() => readInput(file, readFile))).digest;
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
      ".babelrc.mjs",
      ".babelrc.cts",
      ".babelignore",
      "babel.config.js",
      "babel.config.cjs",
      "babel.config.json",
      "babel.config.mjs",
      "babel.config.cts",
      "babel.config.ts",
      "babel.config.mts"
    ].map((name) => join(directory, name))
  ]);
}

export async function fingerprintFiles(
  files: Iterable<string>,
  io = getCompilationIoPool()
): Promise<Map<string, string | null>> {
  return new Map(
    await Promise.all(
      [...new Set(files)].map(
        async (file) => [file, await fileDigest(file, io)] as const
      )
    )
  );
}

export async function unchangedFiles(
  fingerprints: ReadonlyMap<string, string | null>,
  io = getCompilationIoPool()
): Promise<boolean> {
  const current = await fingerprintFiles(fingerprints.keys(), io);

  return [...fingerprints].every(
    ([file, digest]) => current.get(file) === digest
  );
}

export async function hasExternalBabelConfiguration(
  files: ReadonlyMap<string, string | null>,
  io = getCompilationIoPool()
): Promise<boolean> {
  return new CompilationInputs(undefined, io).hasExternalBabelConfiguration(
    files
  );
}
