import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  realpath,
  symlink,
  unlink
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import esbuild from "esbuild";
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
