import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  rm,
  realpath,
  symlink,
  unlink
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import esbuild from "esbuild";
import type { TransformOptions } from "@babel/core";
import { cachedCompile } from "./compileCache.js";
import { compile } from "./compile.js";
import { CompilationCache } from "./compilationCache.js";
import { CompilationDiagnostics } from "./diagnostics.js";
import { processDefineRulesPresetRegistryFile } from "./defineRulesPreset.js";

it("rejects a live dependency retarget instead of assigning another producer's assets", async () => {
  const cacheDir = join(process.cwd(), ".cache");
  await mkdir(cacheDir, { recursive: true });
  const root = await realpath(
    await mkdtemp(join(cacheDir, "selected-physical-origin-"))
  );
  try {
    const link = join(root, "theme.css.ts");
    const filePath = join(root, "owner.css.ts");
    await writeFile(join(root, "package.json"), '{"name":"native-symlink"}');
    for (const color of ["red", "blue"]) {
      await mkdir(join(root, color));
      await writeFile(
        join(root, color, "theme.css.ts"),
        `import {globalStyle} from '@vanilla-extract/css';globalStyle('.probe',{color:'${color}',backgroundImage:'url("./icon.svg")'});`
      );
      await writeFile(join(root, color, "icon.svg"), `<svg>${color}</svg>`);
    }
    const first = join(root, "red", "theme.css.ts");
    const next = join(root, "blue", "theme.css.ts");
    await symlink(first, link);
    const options = {
      cwd: root,
      filePath,
      originalPath: filePath,
      contents: 'import "./theme.css.ts";',
      resolverCache: new Map(),
      esbuild: {
        ...esbuild,
        build<T extends esbuild.BuildOptions>(
          options: Parameters<typeof esbuild.build<T>>[0]
        ) {
          return esbuild.build<T>(
            Object.assign({}, options, { preserveSymlinks: true })
          );
        }
      }
    };
    const assertOrigin = async (origin: string, color: string) => {
      const result = await compile(options);
      const observed: unknown[] = [];
      await processDefineRulesPresetRegistryFile({
        ...result,
        filePath,
        async serializeCssArtifact(artifact) {
          observed.push([
            artifact.origin,
            artifact.cssObjs,
            await readFile(join(dirname(artifact.origin), "icon.svg"), "utf8")
          ]);
          return "";
        }
      });
      expect(observed).toEqual([
        [
          origin,
          expect.arrayContaining([
            expect.objectContaining({
              rule: expect.objectContaining({ color })
            })
          ]),
          `<svg>${color}</svg>`
        ]
      ]);
    };
    await assertOrigin(first, "red");
    const cache = new CompilationCache();
    const readSource = vi.spyOn(cache, "readFile");
    const cachedMode = await compile({ ...options, cache });
    expect(readSource).toHaveBeenCalledWith(first);
    expect(readSource).not.toHaveBeenCalledWith(link);
    expect(cachedMode.watchFiles).toEqual(
      expect.arrayContaining([first, link])
    );

    let retargeted = false;
    await expect(
      compile({
        ...options,
        async readFile(file) {
          const contents = await readFile(file, "utf8");
          if (file === link) {
            await unlink(link);
            await symlink(next, link);
            retargeted = true;
          }
          return contents;
        }
      })
    ).rejects.toThrow(
      "Mincho source producer changed during compilation: " + link
    );
    expect(retargeted).toBe(true);
    await assertOrigin(next, "blue");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("sidecar compilation cache", () => {
  it("invalidates scoped dependencies when configured parser plugins change", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "compile-parser-"))
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    onTestFinished(async () => {
      cwd.mockRestore();
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(
      join(root, "package.json"),
      '{"name":"compile-parser-fixture"}'
    );
    await writeFile(
      join(root, "dependency.ts"),
      `
      const sealed = (value: unknown) => value;
      export @sealed class Factory {}
    `
    );
    const build = vi.fn(esbuild.build);
    const options = {
      cache: new CompilationCache(),
      esbuild: { ...esbuild, build },
      cwd: root,
      filePath: join(root, "entry.css.ts"),
      originalPath: join(root, "entry.ts"),
      contents: 'export { Factory } from "./dependency.ts";',
      resolverCache: new Map<string, string>(),
      parserPlugins: [
        ["decorators", { decoratorsBeforeExport: false }]
      ] as NonNullable<TransformOptions["parserOpts"]>["plugins"]
    };

    await compile({ ...options, resolverCache: new Map() });
    await compile({ ...options, resolverCache: new Map() });
    expect(build).toHaveBeenCalledTimes(1);
    await expect(
      compile({ ...options, resolverCache: new Map(), parserPlugins: [] })
    ).rejects.toThrow(/decorators/);
    expect(build).toHaveBeenCalledTimes(2);
  });

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
    { target: "package", persistent: false },
    { target: "package", persistent: true },
    { target: "scoped-package-subpath", persistent: false },
    { target: "directory-subpath", persistent: false },
    { target: "directory-subpath", persistent: true },
    { target: "package-import", persistent: false },
    { target: "package-import", persistent: true },
    { target: "relative-path", persistent: true }
  ] as const)(
    "follows retargeted $target resolutions with persistent cache $persistent",
    async ({ target, persistent }) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "cache-package-alias-"))
      );
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
      onTestFinished(async () => {
        cwd.mockRestore();
        await rm(root, { recursive: true, force: true });
      });
      await writeFile(
        join(root, "package.json"),
        '{"name":"package-alias-test"}'
      );
      const scoped = target === "scoped-package-subpath";
      const directory = target === "directory-subpath";
      const packageName = scoped ? "@fixture/theme-tokens" : "theme-tokens";
      await mkdir(join(root, "node_modules", ...(scoped ? ["@fixture"] : [])), {
        recursive: true
      });
      if (directory) await mkdir(join(root, "alias-root"));
      for (const color of ["red", "blue"]) {
        await mkdir(join(root, color));
        await writeFile(
          join(root, color, "package.json"),
          JSON.stringify({
            name: packageName,
            exports: { ".": "./tokens.ts", "./tokens": "./tokens.ts" }
          })
        );
        await writeFile(
          join(root, color, "tokens.ts"),
          `export const color = "${color}";`
        );
      }
      const link = directory
        ? join(root, "alias-root", "current")
        : join(root, "node_modules", packageName);
      await symlink(join(root, "red"), link, "dir");
      const cacheDirectory = join(root, "cache");
      const createCache = () => {
        const cache = new CompilationCache();
        if (persistent)
          cache.configure(undefined, cacheDirectory, "alias-test");
        return cache;
      };
      const cache = createCache();
      const build = vi.fn(esbuild.build);
      const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
      const options = {
        cache,
        esbuild: { ...esbuild, build },
        originalPath: join(root, "owner.ts"),
        filePath: join(root, "owner.css.ts"),
        cwd: root,
        contents: `export { color } from "${target === "package-import" ? packageName : directory ? "preset/current/tokens.ts" : "preset"}";`,
        alias:
          target === "package-import"
            ? undefined
            : {
                preset: directory
                  ? "./alias-root"
                  : target === "relative-path"
                    ? "./node_modules/theme-tokens/tokens.ts"
                    : scoped
                      ? `${packageName}/tokens`
                      : packageName
              },
        resolverCache: new Map<string, string>()
      };
      const run = () =>
        diagnostics.run(options.filePath, "package-alias", () =>
          compile({ ...options, cache: persistent ? createCache() : cache })
        );

      expect((await run()).source).toContain('"red"');
      expect((await run()).source).toContain('"red"');
      // Old physical files, source and alias text remain unchanged. A fresh
      // cache instance also exercises the previous persistent manifest.
      await unlink(link);
      await symlink(join(root, "blue"), link, "dir");
      expect((await run()).source).toContain('"blue"');
      expect((await run()).source).toContain('"blue"');

      // Exact resolution proofs retain warm hits for every supported shape.
      expect(build).toHaveBeenCalledTimes(2);
      const bypasses = diagnostics
        .snapshot()
        .builds.flatMap((entry) => entry.events)
        .filter(
          (entry) =>
            entry.phase === "cache-bypass" &&
            (entry.detail as { reason?: string })?.reason ===
              "unverifiable-resolution"
        );
      expect(bypasses).toHaveLength(0);
      if (persistent)
        expect((await readdir(cacheDirectory)).length).toBeGreaterThan(0);
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

  it.each([
    "absolute-file",
    "relative-file",
    "absolute-directory",
    "relative-directory"
  ])(
    "does not publish compilation when its %s alias retargets during the build",
    async (target) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "cache-alias-publication-"))
      );
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
      onTestFinished(async () => {
        cwd.mockRestore();
        await rm(root, { recursive: true, force: true });
      });

      await writeFile(
        join(root, "package.json"),
        '{"name":"alias-publication-test"}'
      );
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
      build.mockImplementationOnce(async (options) => {
        // The cache has sampled red, but esbuild resolves the alias to blue.
        await unlink(link);
        await symlink(join(root, "blue"), link, "dir");
        return esbuild.build(options);
      });
      const options = {
        cache: new CompilationCache(),
        esbuild: { ...esbuild, build },
        originalPath: join(root, "owner.ts"),
        filePath: join(root, "owner.css.ts"),
        cwd: root,
        contents: `export { color } from "${directory ? "preset/tokens" : "preset"}";`,
        alias: {
          preset: target.startsWith("relative")
            ? `./${replacement}`
            : join(root, replacement)
        },
        resolverCache: new Map<string, string>()
      };

      expect((await compile(options)).source).toContain('"blue"');
      expect(build).toHaveBeenCalledTimes(1);
      await unlink(link);
      await symlink(join(root, "red"), link, "dir");

      // Both physical files stay unchanged; the old key must not contain blue.
      expect((await compile(options)).source).toContain('"red"');
      expect((await compile(options)).source).toContain('"red"');
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

  it("reuses the native external edge for a scope API resolution query", async () => {
    const filePath = join(process.cwd(), "src/resolve-scope-api.css.ts");
    const build = vi.fn(esbuild.build);
    const options = {
      filePath,
      originalPath: filePath,
      contents:
        'export const descriptor = require.resolve("@vanilla-extract/css/fileScope");',
      cache: new CompilationCache(),
      resolverCache: new Map(),
      esbuild: { ...esbuild, build }
    };
    const first = await compile(options);
    expect(first.source).toContain(
      'require.resolve("@vanilla-extract/css/fileScope")'
    );
    expect((await compile(options)).source).toBe(first.source);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("keeps a dependency's native tsconfig JSX factory on cold and warm compiles", async () => {
    const cacheDir = join(process.cwd(), ".cache");
    await mkdir(cacheDir, { recursive: true });
    const root = await mkdtemp(join(cacheDir, "native-jsx-factory-"));
    try {
      await writeFile(join(root, "package.json"), '{"name":"jsx-fixture"}');
      const dep = join(root, "dependency");
      await mkdir(dep);
      const config = join(dep, "tsconfig.json");
      await writeFile(config, '{"compilerOptions":{"jsxFactory":"h"}}');
      await writeFile(
        join(dep, "view.tsx"),
        `function h(tag: string){return "jsx:" + tag}
          function paint(tag: string){return "paint:" + tag}
          export const color = <tomato />;`
      );
      const filePath = join(root, "owner.css.ts");
      const build = vi.fn(esbuild.build);
      const base = {
        cwd: root,
        originalPath: filePath,
        filePath,
        contents: 'export {color} from "./dependency/view";',
        esbuild: { ...esbuild, build },
        resolverCache: new Map()
      };
      const evaluate = async (result: Awaited<ReturnType<typeof compile>>) =>
        (await processDefineRulesPresetRegistryFile({ ...result, filePath }))
          .source;
      const uncached = await compile(base);
      expect(await evaluate(uncached)).toContain("jsx:tomato");
      const options = { ...base, cache: new CompilationCache() };
      const cold = await compile(options);
      expect(await evaluate(cold)).toBe(await evaluate(uncached));
      const warm = await compile(options);
      expect(await evaluate(warm)).toBe(await evaluate(uncached));
      expect(build).toHaveBeenCalledTimes(2);

      await writeFile(config, '{"compilerOptions":{"jsxFactory":"paint"}}');
      const changed = await compile(options);
      expect(await evaluate(changed)).toContain("paint:tomato");
      expect(build).toHaveBeenCalledTimes(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("revalidates tsconfig paths for a sliced dependency graph", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "cache-tsconfig-"))
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    onTestFinished(async () => {
      cwd.mockRestore();
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(
      join(root, "package.json"),
      '{"name":"cache-tsconfig-test"}'
    );
    for (const color of ["red", "blue"])
      await writeFile(
        join(root, `${color}.ts`),
        `export const palette={color:"${color}",unused:"UNUSED_GRAPH_MEMBER"};`
      );
    const configure = (color: string) =>
      writeFile(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { paths: { tokens: [`./${color}.ts`] } }
        })
      );
    await configure("red");
    const build = vi.fn(esbuild.build);
    const options = {
      cache: new CompilationCache(),
      dependencyGraph: true,
      esbuild: { ...esbuild, build },
      originalPath: join(root, "owner.ts"),
      filePath: join(root, "owner.css.ts"),
      cwd: root,
      contents:
        'import {palette} from "tokens";export const color=palette.color;',
      resolverCache: new Map<string, string>()
    };
    const first = await compile(options);
    expect(first.source).toContain('"red"');
    expect(first.source).not.toContain("UNUSED_GRAPH_MEMBER");
    expect((await compile(options)).source).toBe(first.source);
    expect(build).toHaveBeenCalledTimes(1);
    await configure("blue");
    const changed = await compile(options);
    expect(changed.source).toContain('"blue"');
    expect(changed.source).not.toContain("UNUSED_GRAPH_MEMBER");
    expect((await compile(options)).source).toBe(changed.source);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "invalidates same-target package sideEffects metadata (persistent: %s)",
    async (persistent) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "cache-side-effects-"))
      );
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
      onTestFinished(async () => {
        cwd.mockRestore();
        await rm(root, { recursive: true, force: true });
      });
      await writeFile(
        join(root, "package.json"),
        '{"name":"cache-side-effects-test"}'
      );
      const directory = join(root, "node_modules", "package-effect");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "index.js"),
        "globalThis.PACKAGE_SIDE_EFFECT=true;"
      );
      const configure = (sideEffects: boolean) =>
        writeFile(
          join(directory, "package.json"),
          JSON.stringify({
            name: "package-effect",
            main: "index.js",
            sideEffects
          })
        );
      await configure(true);
      const createCache = () => {
        const cache = new CompilationCache();
        if (persistent)
          cache.configure(undefined, join(root, "cache"), "side-effects-test");
        return cache;
      };
      const cache = createCache();
      const build = vi.fn(esbuild.build);
      const options = {
        esbuild: { ...esbuild, build },
        originalPath: join(root, "owner.ts"),
        filePath: join(root, "owner.css.ts"),
        cwd: root,
        contents: 'import "package-effect";export const color="red";',
        resolverCache: new Map<string, string>()
      };
      const run = () =>
        compile({ ...options, cache: persistent ? createCache() : cache });
      const first = await run();
      expect(first.source).toContain("PACKAGE_SIDE_EFFECT");
      expect((await run()).source).toBe(first.source);
      expect(build).toHaveBeenCalledTimes(1);
      // Source bytes and the selected package file are unchanged.
      await configure(false);
      const changed = await run();
      expect(changed.source).not.toContain("PACKAGE_SIDE_EFFECT");
      expect((await run()).source).toBe(changed.source);
      expect(build).toHaveBeenCalledTimes(2);
    }
  );

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

// An opaque Babel config disables result caching, not input consistency.
it.each([false, true])(
  "snapshots package reads while bypassing compilation caching (edit %s)",
  async (edit) => {
    const root = await mkdtemp(join(tmpdir(), "bypass-snapshot-"));
    try {
      await writeFile(join(root, "package.json"), '{"name":"entry"}');
      await writeFile(join(root, ".babelrc"), "{}");
      const dependency = join(root, "outside");
      await mkdir(dependency);
      const manifest = join(dependency, "package.json");
      await writeFile(manifest, '{"name":"before"}');
      const cache = new CompilationCache();
      const cacheRun = vi.spyOn(cache, "run");
      const seen: Array<string | undefined> = [];
      const run = cachedCompile(
        {
          cache,
          cwd: root,
          filePath: join(root, "entry.css.ts"),
          originalPath: join(root, "entry.ts"),
          contents: "export {};",
          resolverCache: new Map()
        },
        async (options) => {
          expect(options.readPackageFile).toBeTypeOf("function");
          seen.push(await options.readPackageFile!(manifest));
          if (edit) await writeFile(manifest, '{"name":"after"}');
          seen.push(await options.readPackageFile!(manifest));
          return {
            source: "export {};",
            cssScopeOrigins: [],
            watchFiles: [manifest]
          };
        }
      );
      if (edit)
        await expect(run).rejects.toThrow(
          "Mincho inputs changed during compilation: " + manifest
        );
      else await expect(run).resolves.toMatchObject({ source: "export {};" });
      expect(cacheRun).not.toHaveBeenCalled();
      expect(seen).toEqual(['{"name":"before"}', '{"name":"before"}']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

it.each(["file", "missing"])(
  "rejects a snapshotted package directory becoming %s before publication",
  async (next) => {
    const root = await mkdtemp(join(tmpdir(), "directory-snapshot-"));
    const manifest = join(root, "package.json");
    try {
      await mkdir(manifest);
      const cache = new CompilationCache();
      await expect(
        cachedCompile(
          {
            cache,
            cwd: root,
            filePath: join(root, "entry.css.ts"),
            originalPath: join(root, "entry.ts"),
            contents: "export {};",
            resolverCache: new Map()
          },
          async (options) => {
            await expect(
              options.readPackageFile!(manifest)
            ).rejects.toMatchObject({ code: "EISDIR" });
            await rm(manifest, { recursive: true });
            if (next === "file")
              await writeFile(manifest, '{"name":"new-owner"}');
            return {
              source: "export {};",
              cssScopeOrigins: [],
              watchFiles: [manifest]
            };
          }
        )
      ).rejects.toThrow("inputs changed during compilation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

it.each([false, true])(
  "invalidates byte-identical producer retargeting (persistent: %s)",
  async (persistent) => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await mkdtemp(
      join(process.cwd(), ".cache", "physical-producer-cache-")
    );
    try {
      await writeFile(
        join(root, "package.json"),
        '{"name":"physical-producer-cache"}'
      );
      const stylesheet = `import {style} from '@vanilla-extract/css';
      export const box=style({backgroundImage:'url("./icon.svg")'});`;
      for (const directory of ["a", "b"]) {
        await mkdir(join(root, directory));
        await writeFile(join(root, directory, "tokens.ts"), stylesheet);
        await writeFile(
          join(root, directory, "icon.svg"),
          `<svg>${directory}</svg>`
        );
      }
      const alias = join(root, "tokens.ts");
      const issuer = join(root, "entry.css.ts");
      await symlink(join(root, "a", "tokens.ts"), alias);
      const build = vi.fn(esbuild.build);
      const makeCache = () => {
        const cache = new CompilationCache();
        if (persistent)
          cache.configure(
            undefined,
            join(root, "results"),
            "producer-retarget"
          );
        return cache;
      };
      let cache = makeCache();
      const run = () =>
        compile({
          filePath: issuer,
          originalPath: issuer,
          cwd: root,
          cache,
          esbuild: { ...esbuild, build },
          contents: "export * from './tokens';",
          resolverCache: new Map()
        });
      const serialize = async (
        compiled: Awaited<ReturnType<typeof compile>>,
        expected: string
      ) => {
        const origins: string[] = [];
        await processDefineRulesPresetRegistryFile({
          ...compiled,
          filePath: issuer,
          async serializeCssArtifact(artifact) {
            origins.push(artifact.origin);
            expect(JSON.stringify(artifact.cssObjs)).toContain("./icon.svg");
            const asset = await readFile(
              join(dirname(artifact.origin), "icon.svg"),
              "utf8"
            );
            expect(asset).toBe(`<svg>${expected}</svg>`);
            return "";
          }
        });
        expect(origins).toEqual([join(root, expected, "tokens.ts")]);
      };
      await serialize(await run(), "a");
      expect(build).toHaveBeenCalledTimes(1);
      if (persistent) cache = makeCache(); // real disk restore, not a memory hit
      await serialize(await run(), "a");
      expect(build).toHaveBeenCalledTimes(1);
      await unlink(alias);
      await symlink(join(root, "b", "tokens.ts"), alias);
      if (persistent) cache = makeCache();
      await serialize(await run(), "b");
      expect(build).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
