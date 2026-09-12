import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OutputFile } from "esbuild";

async function replaceFile(path: string, contents: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.mincho-${randomUUID()}.tmp`);

  try {
    const existing = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;

      throw error;
    });

    await writeFile(temporary, contents, { flag: "wx" });
    if (existing?.isFile()) await chmod(temporary, existing.mode & 0o7777);

    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Restore touched files on I/O failure; this is not a filesystem-wide atomic rename. */
export async function publishOutputs(
  outputs: readonly OutputFile[]
): Promise<void> {
  const directory = Symbol("directory");
  const backups = new Map<string, Buffer | null | typeof directory>();

  for (const output of outputs) {
    const backup = await readFile(output.path).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;

        // Preserve directories, then let the normal file write report its error.
        if (error.code === "EISDIR") return directory;

        throw error;
      }
    );

    backups.set(output.path, backup);
  }

  const attempted: string[] = [];
  const published: string[] = [];

  try {
    for (const output of outputs) {
      attempted.push(output.path);
      await mkdir(dirname(output.path), { recursive: true });
      await replaceFile(output.path, output.contents);
      published.push(output.path);
    }
  } catch (cause) {
    const rollbackFailures: string[] = [];

    for (const path of attempted.reverse()) {
      const backup = backups.get(path);
      if (backup === directory || backup === undefined) continue;

      try {
        if (backup === null) await rm(path, { force: true });
        else await replaceFile(path, backup);
      } catch (error) {
        rollbackFailures.push(
          `${path}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    throw new Error(
      `Mincho output publication failed. Published paths: ${JSON.stringify(published)}. ${rollbackFailures.length ? `Rollback failures: ${rollbackFailures.join("; ")}` : "Touched output files were restored."}`,
      { cause }
    );
  }
}
