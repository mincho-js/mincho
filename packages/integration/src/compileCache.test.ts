import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  realpath,
  symlink,
  unlink
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import esbuild from "esbuild";
import { compile } from "./compile.js";
import { CompilationCache } from "./compilationCache.js";
import { CompilationDiagnostics } from "./diagnostics.js";

describe("sidecar compilation cache", () => {
  it.each(["alias", "resolvedImports"] as const)(
    "resolves authoring source %s and invalidates changed targets",
    async (resolution) => {
      const root = await mkdtemp(join(tmpdir(), "compile-alias-"));
      onTestFinished(() => rm(root, { recursive: true, force: true }));
      await writeFile(
        join(root, "package.json"),
        '{"name":"compile-alias-fixture"}'
      );
      for (const color of ["red", "blue"])
        await writeFile(
          join(root, `${color}.ts`),
          `export const color = "${color}";`
        );
      const build = vi.fn(esbuild.build);
      const options = {
        cache: new CompilationCache(),
        esbuild: { ...esbuild, build },
        originalPath: join(root, "owner.ts"),
        filePath: join(root, "owner.css.ts"),
        cwd: root,
        contents: 'export { color } from "test-preset";',
        resolverCache: new Map<string, string>()
      };
      const run = (color: string) =>
        compile({
          ...options,
          [resolution]: { "test-preset": join(root, `${color}.ts`) }
        });

      expect((await run("red")).source).toContain('"red"');
      expect((await run("blue")).source).toContain('"blue"');
      expect((await run("red")).source).toContain('"red"');
      expect(build).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    { option: "alias", target: "absolute-file" },
    { option: "alias", target: "relative-file" },
    { option: "alias", target: "absolute-directory" },
    { option: "alias", target: "relative-directory" },
    { option: "resolvedImports", target: "absolute-file" }
  ] as const)(
    "invalidates $option when its $target symlink changes target",
    async ({ option, target }) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "cache-alias-retarget-"))
      );

      // Keep Babel's cwd fingerprint independent of sibling test fixtures.
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
      onTestFinished(async () => {
        cwd.mockRestore();
        await rm(root, { recursive: true, force: true });
      });

      await writeFile(
        join(root, "package.json"),
        '{"name":"alias-retarget-test"}'
      );
      await mkdir(join(root, "app"));
      for (const color of ["red", "blue"]) {
        await mkdir(join(root, color));
        await writeFile(
          join(root, color, "tokens.ts"),
          `export const color = "${color}";`
        );
      }

      const link = join(root, "current");
      await symlink(join(root, "red"), link, "dir");

      const directory = target.endsWith("directory");
      const replacement = directory ? "current" : "current/tokens.ts";
      const build = vi.fn(esbuild.build);
      const options = {
        cache: new CompilationCache(),
        esbuild: { ...esbuild, build },
        originalPath: join(root, "app", "owner.ts"),
        filePath: join(root, "app", "owner.css.ts"),
        cwd: root,
        contents: `export { color } from "${directory ? "preset/tokens" : "preset"}";`,
        [option]: {
          preset: target.startsWith("relative")
            ? `./${replacement}`
            : join(root, replacement)
        },
        resolverCache: new Map<string, string>()
      };

      expect((await compile(options)).source).toContain('"red"');
      expect((await compile(options)).source).toContain('"red"');
      expect(build).toHaveBeenCalledTimes(1);

      // The entry, alias string and old physical dependency stay unchanged.
      // Only the symlink destination moves to another existing directory.
      await unlink(link);
      await symlink(join(root, "blue"), link, "dir");

      expect((await compile(options)).source).toContain('"blue"');
      expect((await compile(options)).source).toContain('"blue"');
      expect(build).toHaveBeenCalledTimes(2);
    }
  );

  it.each(["absolute", "relative"] as const)(
    "does not reuse unresolved %s aliases after extension-resolved symlinks move",
    async (target) => {
      const root = await mkdtemp(join(tmpdir(), "cache-alias-extension-"));
      onTestFinished(() => rm(root, { recursive: true, force: true }));

      await writeFile(
        join(root, "package.json"),
        '{"name":"alias-extension-test"}'
      );
      for (const color of ["red", "blue"])
        await writeFile(
          join(root, `${color}.ts`),
          `export const color = "${color}";`
        );

      const link = join(root, "current.ts");
      await symlink(join(root, "red.ts"), link);

      const options = {
        cache: new CompilationCache(),
        originalPath: join(root, "owner.ts"),
        filePath: join(root, "owner.css.ts"),
        cwd: root,
        contents: 'export { color } from "preset";',
        alias: {
          preset: target === "relative" ? "./current" : join(root, "current")
        },
        resolverCache: new Map<string, string>()
      };

      expect((await compile(options)).source).toContain('"red"');
      await unlink(link);
      await symlink(join(root, "blue.ts"), link);
      expect((await compile(options)).source).toContain('"blue"');
    }
  );

  it.each([false, true])(
    "resolves direct-file mapped symlinks from their physical owner (cache: %s)",
    async (cached) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "mapped-file-symlink-"))
      );
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
      onTestFinished(async () => {
        cwd.mockRestore();
        await rm(root, { recursive: true, force: true });
      });

      await writeFile(
        join(root, "package.json"),
        '{"name":"mapped-file-symlink-test"}'
      );
      await mkdir(join(root, "app"));
      await writeFile(
        join(root, "app", "tokens.ts"),
        'export const color = "wrong-owner";'
      );
      for (const color of ["red", "blue"]) {
        await mkdir(join(root, color));
        await writeFile(
          join(root, color, "index.ts"),
          'export { color } from "./tokens";'
        );
        await writeFile(
          join(root, color, "tokens.ts"),
          `export const color = "${color}";`
        );
      }

      const link = join(root, "app", "preset.ts");
      await symlink(join(root, "red", "index.ts"), link);
      const build = vi.fn(esbuild.build);
      const options = {
        cache: cached ? new CompilationCache() : undefined,
        esbuild: { ...esbuild, build },
        originalPath: join(root, "app", "owner.ts"),
        filePath: join(root, "app", "owner.css.ts"),
        cwd: root,
        contents: 'export { color } from "preset";',
        resolvedImports: { preset: link },
        resolverCache: new Map<string, string>()
      };

      for (const color of ["red", "blue"]) {
        if (color === "blue") {
          await unlink(link);
          await symlink(join(root, color, "index.ts"), link);
        }

        for (let repeat = 0; repeat < 2; repeat++) {
          const result = await compile(options);
          expect(result.source).toContain(`"${color}"`);
          expect(result.source).not.toContain("wrong-owner");
          expect(result.watchFiles).toContain(join(root, color, "index.ts"));
          expect(result.watchFiles).toContain(join(root, color, "tokens.ts"));
        }
      }

      expect(build).toHaveBeenCalledTimes(cached ? 2 : 4);
    }
  );

  it("invalidates when a workspace symlink is retargeted", async () => {
    const root = await mkdtemp(join(tmpdir(), "cache-retarget-"));
    const alias = join(root, "workspace");
    try {
      for (const color of ["red", "blue"]) {
        const directory = join(root, color);
        await mkdir(directory);
        await writeFile(
          join(directory, "package.json"),
          '{"name":"retarget-test"}'
        );
        await writeFile(
          join(directory, "dep.ts"),
          `export const color = "${color}";`
        );
      }
      const options = {
        cwd: alias,
        filePath: join(alias, "owner.css.ts"),
        originalPath: join(alias, "owner.ts"),
        contents: 'export { color } from "./dep";',
        cache: new CompilationCache(),
        resolverCache: new Map<string, string>()
      };
      await symlink(join(root, "red"), alias, "dir");
      expect((await compile(options)).source).toContain('"red"');
      await unlink(alias);
      await symlink(join(root, "blue"), alias, "dir");
      expect((await compile(options)).source).toContain('"blue"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("observes Babel root config creation, edits and removal outside the owner ancestry", async () => {
    // Keep sibling fixture creation out of observed workspace directory entries.
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await mkdtemp(join(process.cwd(), ".cache", "cache-test-"));
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
          JSON.stringify({ plugins: [join(babelRoot, `${color}.cjs`)] })
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

  it("reuses sliced compilation while retaining absent Babel configuration watches and invalidation", async () => {
    // Isolate both data modules and Babel's working directory from sibling tests.
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "cache-graph-test-"))
    );

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);

    try {
      await writeFile(
        join(root, "package.json"),
        '{"name":"cache-graph-test"}'
      );
      await writeFile(
        join(root, "dep.ts"),
        'export const palette={red:"red",unused:"UNUSED_GRAPH_MEMBER"};'
      );

      const build = vi.fn(esbuild.build);
      const cache = new CompilationCache();
      const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
      const options = {
        cache,
        dependencyGraph: true,
        esbuild: { ...esbuild, build },
        originalPath: join(root, "owner.ts"),
        filePath: join(root, "owner.css.ts"),
        cwd: root,
        contents:
          'import {palette} from "./dep"; export const color=palette.red;',
        resolverCache: new Map<string, string>()
      };

      const run = () =>
        diagnostics.run(options.filePath, "compile-test", () =>
          compile(options)
        );

      const configFile = join(root, ".babelrc.json");
      const first = await run();

      expect(first.source).not.toContain("UNUSED_GRAPH_MEMBER");
      expect(first.watchFiles).toContain(configFile);
      expect((await run()).source).toBe(first.source);
      expect(build).toHaveBeenCalledTimes(1);

      cache.invalidate(configFile);
      await run();

      expect(build).toHaveBeenCalledTimes(2);

      await writeFile(configFile, '{"comments":false}');

      expect((await run()).source).toContain("UNUSED_GRAPH_MEMBER");
      expect(build).toHaveBeenCalledTimes(3);

      await rm(configFile);

      // The absent configuration restores the complete earlier fingerprint, so
      // its previously sliced result is valid again without compiling anew.
      const restored = await run();

      expect(restored.source).toBe(first.source);
      expect(restored.source).not.toContain("UNUSED_GRAPH_MEMBER");
      expect(build).toHaveBeenCalledTimes(3);

      await run();

      expect(build).toHaveBeenCalledTimes(3);

      const events = diagnostics
        .snapshot()
        .builds.flatMap((entry) => entry.events);

      expect(events.some((entry) => entry.phase === "cache-hit")).toBe(true);
      expect(
        events.some(
          (entry) =>
            entry.phase === "cache-bypass" &&
            (entry.detail as { reason?: string })?.reason ===
              "unobserved-watch-file"
        )
      ).toBe(false);
      expect(
        events.some(
          (entry) =>
            entry.phase === "cache-bypass" &&
            (entry.detail as { reason?: string })?.reason ===
              "external-babel-configuration"
        )
      ).toBe(true);
    } finally {
      cwd.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates a loaded sibling's Babel configuration before graph slicing", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "cache-sibling-test-"))
    );

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);

    try {
      await mkdir(join(root, "app"));
      await mkdir(join(root, "shared"));
      await writeFile(
        join(root, "package.json"),
        '{"name":"cache-sibling-test"}'
      );
      await writeFile(
        join(root, "shared", "dep.ts"),
        'export const palette={red:"red",unused:"SIBLING_MEMBER"};'
      );

      const build = vi.fn(esbuild.build);
      const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
      const options = {
        cache: new CompilationCache(),
        dependencyGraph: true,
        esbuild: { ...esbuild, build },
        originalPath: join(root, "app", "owner.ts"),
        filePath: join(root, "app", "owner.css.ts"),
        cwd: root,
        contents:
          'import {palette} from "../shared/dep"; export const color=palette.red;',
        resolverCache: new Map<string, string>()
      };

      const run = () =>
        diagnostics.run(options.filePath, "compile-test", () =>
          compile(options)
        );

      const configFile = join(root, "shared", ".babelrc.json");
      const first = await run();

      expect(first.source).not.toContain("SIBLING_MEMBER");
      expect(first.watchFiles).toContain(configFile);

      await run();

      expect(build).toHaveBeenCalledTimes(1);

      await writeFile(configFile, '{"comments":false}');

      expect((await run()).source).toContain("SIBLING_MEMBER");
      expect(build).toHaveBeenCalledTimes(2);

      await writeFile(configFile, '{"comments":false,"compact":true}');

      expect((await run()).source).toContain("SIBLING_MEMBER");
      expect(build).toHaveBeenCalledTimes(3);

      const events = diagnostics
        .snapshot()
        .builds.flatMap((entry) => entry.events);

      expect(
        events.some(
          (entry) =>
            entry.phase === "dependency-graph-bypass" &&
            (entry.detail as { reason?: string })?.reason ===
              "external-babel-configuration"
        )
      ).toBe(true);

      await rm(configFile);

      expect((await run()).source).not.toContain("SIBLING_MEMBER");

      await run();

      expect(build).toHaveBeenCalledTimes(4);
    } finally {
      cwd.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips unchanged compilation and invalidates source, dependencies and configuration", async () => {
    // Keep sibling fixture creation out of observed workspace directory entries.
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await mkdtemp(join(process.cwd(), ".cache", "cache-test-"));

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);

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
      cwd.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
