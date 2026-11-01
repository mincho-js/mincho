import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Resolve existing prefixes too: generated sidecar filenames need not exist yet. */
export async function canonicalFilePath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    const parent = dirname(absolute);
    return parent === absolute
      ? absolute
      : join(await canonicalFilePath(parent), basename(absolute));
  }
}
