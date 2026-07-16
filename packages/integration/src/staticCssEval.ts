import * as fs from "node:fs";
import { join, resolve as resolvePath } from "node:path";

export const unsupportedStaticCssEvalResolutionPrefix =
  "virtual:mincho-static-css-eval-unsupported:";

export function createUnsupportedStaticCssEvalResolution(importPath: string): {
  id: string;
} {
  return {
    id: `${unsupportedStaticCssEvalResolutionPrefix}${encodeURIComponent(
      importPath
    )}`
  };
}

export function isUnsupportedStaticCssEvalResolutionId(id: string): boolean {
  return id.startsWith(unsupportedStaticCssEvalResolutionPrefix);
}

export function isProjectLocalImportPath(importPath: string): boolean {
  return importPath.startsWith(".") || importPath.startsWith("/");
}

export function isVirtualStaticCssEvalId(id: string): boolean {
  return (
    id.startsWith("\0") ||
    id.includes("\0") ||
    id.startsWith("virtual:") ||
    id.includes("__x00__")
  );
}

export function hasNodeModulesSegment(
  filePath: string,
  normalizeFilePath: (filePath: string) => string
): boolean {
  return normalizeFilePath(filePath).split("/").includes("node_modules");
}

export function isPathInsideRoot(
  rootPath: string,
  filePath: string,
  normalizeFilePath: (filePath: string) => string
): boolean {
  const normalizedRoot = trimTrailingSlash(normalizeFilePath(rootPath));
  const normalizedFilePath = trimTrailingSlash(normalizeFilePath(filePath));
  const descendantPrefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;

  return (
    normalizedFilePath === normalizedRoot ||
    normalizedFilePath.startsWith(descendantPrefix)
  );
}

export function trimTrailingSlash(filePath: string): string {
  if (filePath.length <= 1) {
    return filePath;
  }

  let end = filePath.length;

  while (end > 1 && filePath[end - 1] === "/") {
    end -= 1;
  }

  return end === filePath.length ? filePath : filePath.slice(0, end);
}

export async function getRealpathOrResolvedPath(
  filePath: string,
  options: {
    normalizeFilePath: (filePath: string) => string;
    resolvePath: (filePath: string) => string;
  }
): Promise<string> {
  return (
    (await getExistingRealpath(filePath, options.normalizeFilePath)) ??
    options.normalizeFilePath(options.resolvePath(filePath))
  );
}

export async function getExistingRealpath(
  filePath: string,
  normalizeFilePath: (filePath: string) => string
): Promise<string | null> {
  try {
    return normalizeFilePath(await fs.promises.realpath(filePath));
  } catch {
    return null;
  }
}

export function createStaticCssEvalSourceHash(stat: {
  mtimeMs: number;
  size: number;
}): string {
  return `mtime:${stat.mtimeMs}:size:${stat.size}`;
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  describe("static css eval shared helpers", () => {
    it("encodes and matches unsupported virtual resolution ids", () => {
      const resolution =
        createUnsupportedStaticCssEvalResolution("./styles?foo=bar");

      expect(resolution.id).toBe(
        "virtual:mincho-static-css-eval-unsupported:.%2Fstyles%3Ffoo%3Dbar"
      );
      expect(isUnsupportedStaticCssEvalResolutionId(resolution.id)).toBe(true);
      expect(
        isUnsupportedStaticCssEvalResolutionId("/project/src/styles.ts")
      ).toBe(false);
    });

    it("classifies project-local imports and virtual ids", () => {
      expect(isProjectLocalImportPath("./styles")).toBe(true);
      expect(isProjectLocalImportPath("/src/styles")).toBe(true);
      expect(isProjectLocalImportPath("pkg/styles")).toBe(false);
      expect(isVirtualStaticCssEvalId("virtual:styles")).toBe(true);
      expect(isVirtualStaticCssEvalId("\0virtual")).toBe(true);
      expect(isVirtualStaticCssEvalId("/project/src/styles.ts")).toBe(false);
    });

    it("normalizes node_modules and root boundary checks through callbacks", () => {
      const normalizeFilePath = (filePath: string) =>
        filePath.replace(/\\/g, "/");

      expect(
        hasNodeModulesSegment(
          "C:\\project\\node_modules\\pkg\\styles.ts",
          normalizeFilePath
        )
      ).toBe(true);
      expect(
        isPathInsideRoot("/project", "/project/src/styles.ts", (value) => value)
      ).toBe(true);
      expect(
        isPathInsideRoot("/project/", "/projected/styles.ts", (value) => value)
      ).toBe(false);
      expect(
        isPathInsideRoot("/", "/project/styles.ts", (value) => value)
      ).toBe(true);
      expect(trimTrailingSlash("/project/src///")).toBe("/project/src");
      expect(trimTrailingSlash("/")).toBe("/");
      expect(trimTrailingSlash("///")).toBe("/");
    });

    it("falls back to a resolved path when no realpath exists", async () => {
      const root = await fs.promises.mkdtemp(
        join(process.cwd(), ".tmp-static-css-eval-")
      );

      try {
        const missingPath = join(root, "src", "styles.ts");

        await expect(
          getExistingRealpath(missingPath, (value) => value)
        ).resolves.toBeNull();
        await expect(
          getRealpathOrResolvedPath(missingPath, {
            normalizeFilePath: (value) => value,
            resolvePath: (value) => resolvePath(value)
          })
        ).resolves.toBe(resolvePath(missingPath));
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    });

    it("hashes source metadata deterministically", () => {
      expect(createStaticCssEvalSourceHash({ mtimeMs: 1.5, size: 42 })).toBe(
        "mtime:1.5:size:42"
      );
    });
  });
}
