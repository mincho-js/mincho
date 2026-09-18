import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import esbuild from "esbuild";
import { compile } from "./compile.js";
import { CompilationCache } from "./compilationCache.js";

describe("sidecar compilation cache", () => {
  it("observes Babel root config creation, edits and removal outside the owner ancestry", async () => {
    const root = await mkdtemp(join(process.cwd(), "cache-test-"));
    const babelRoot = join(root, "app");
    const sourceRoot = join(root, "source");
    let cwd: ReturnType<typeof vi.spyOn> | undefined;

    try {
      await mkdir(babelRoot);
      await mkdir(sourceRoot);
      await writeFile(
        join(sourceRoot, "package.json"),
        '{"name":"cache-test"}'
      );
      await writeFile(
        join(sourceRoot, "dep.ts"),
        'export const color = "red";'
      );

      for (const color of ["blue", "green"])
        await writeFile(
          join(babelRoot, `${color}.cjs`),
          `module.exports = () => ({ visitor: { StringLiteral(path) { if (path.node.value === "red") path.node.value = "${color}"; } } });`
        );

      cwd = vi.spyOn(process, "cwd").mockReturnValue(babelRoot);

      const build = vi.fn(esbuild.build);
      const options = {
        cache: new CompilationCache(),
        esbuild: { ...esbuild, build },
        originalPath: join(sourceRoot, "owner.ts"),
        filePath: join(sourceRoot, "owner.css.ts"),
        cwd: sourceRoot,
        contents: 'export { color } from "./dep";',
        resolverCache: new Map<string, string>()
      };

      expect((await compile(options)).source).toContain("red");
      expect((await compile(options)).source).toContain("red");
      expect(build).toHaveBeenCalledTimes(1);

      const config = join(babelRoot, "babel.config.json");

      for (const color of ["blue", "green"]) {
        await writeFile(
          config,
          JSON.stringify({ plugins: [`./${color}.cjs`] })
        );

        expect((await compile(options)).source).toContain(color);
      }

      await rm(config);

      expect((await compile(options)).source).toContain("red");
      expect((await compile(options)).source).toContain("red");
      expect(build).toHaveBeenCalledTimes(3);
    } finally {
      cwd?.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips unchanged compilation and invalidates source, dependencies and configuration", async () => {
    const root = await mkdtemp(join(process.cwd(), "cache-test-"));

    try {
      await writeFile(join(root, "package.json"), '{"name":"cache-test"}');
      await writeFile(join(root, "dep.ts"), 'export const color = "red";');

      const build = vi.fn(esbuild.build);
      const options = {
        cache: new CompilationCache(),
        esbuild: { ...esbuild, build },
        originalPath: join(root, "owner.ts"),
        filePath: join(root, "owner.css.ts"),
        cwd: root,
        contents: 'export { color } from "./dep";',
        resolverCache: new Map<string, string>()
      };

      const first = await compile(options);

      expect((await compile(options)).source).toBe(first.source);
      expect(build).toHaveBeenCalledTimes(1);

      await writeFile(join(root, "dep.ts"), 'export const color = "blue";');

      expect((await compile(options)).source).toContain("blue");
      expect(build).toHaveBeenCalledTimes(2);

      await writeFile(
        join(root, "tsconfig.json"),
        '{"compilerOptions":{"target":"es2020"}}'
      );
      await compile(options);

      expect(build).toHaveBeenCalledTimes(3);

      options.contents = "export const changed = true;";

      expect((await compile(options)).source).toContain("changed");
      expect(build).toHaveBeenCalledTimes(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
