import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import esbuild, { type Plugin } from "esbuild";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { CompileOptions } from "./compile.js";
import {
  compilationResolutionOptions,
  createCompileResolutionObserver,
  resolvedImportPlugin,
  validateCompileResolutions
} from "./compileResolution.js";

async function fixture(contents: string): Promise<CompileOptions> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "compile-resolution-"))
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "app"));
  await writeFile(
    join(root, "package.json"),
    '{"name":"resolution-fixture","type":"module"}'
  );
  return {
    contents,
    cwd: root,
    originalPath: join(root, "app", "owner.ts"),
    filePath: join(root, "app", "owner.css.ts"),
    resolverCache: new Map()
  };
}

async function capture(options: CompileOptions, plugins: Plugin[] = []) {
  const observer = createCompileResolutionObserver(options);
  const build = (observe: boolean) =>
    esbuild.build({
      ...compilationResolutionOptions(options),
      stdin: {
        contents: options.contents,
        loader: "ts",
        sourcefile: "owner.css.ts",
        resolveDir: dirname(options.filePath)
      },
      bundle: true,
      metafile: true,
      write: false,
      logLevel: "silent",
      plugins: [
        ...(observe ? [observer.plugin] : []),
        ...resolvedImportPlugin(options),
        ...plugins.map((plugin) =>
          observe ? observer.observePlugin(plugin) : plugin
        )
      ]
    });
  const ordinary = await build(false);
  const observed = await build(true);
  expect(observed.outputFiles[0]?.text).toBe(ordinary.outputFiles[0]?.text);
  expect(observed.metafile).toEqual(ordinary.metafile);
  return observer.finish(observed.metafile);
}

describe("native compilation resolution proofs", () => {
  it.each([
    "extension",
    "nearer-package",
    "package-exports",
    "side-effects"
  ] as const)(
    "rechecks %s lookup changes without recompiling or loading sources",
    async (change) => {
      const options = await fixture(
        `export { color } from "${change === "extension" ? "./dep" : "theme-tokens"}";`
      );
      const root = options.cwd!;
      await mkdir(join(root, "node_modules", "theme-tokens"), {
        recursive: true
      });
      const packagePath = join(root, "node_modules", "theme-tokens");
      await writeFile(
        join(packagePath, "package.json"),
        '{"exports":"./red.js"}'
      );
      await writeFile(join(packagePath, "red.js"), 'export const color="red";');
      await writeFile(
        join(packagePath, "blue.js"),
        'export const color="blue";'
      );
      await writeFile(join(root, "app", "dep.js"), 'export const color="red";');
      const manifest = await capture(options);
      expect(manifest).toBeDefined();

      const build = vi.fn(esbuild.build);
      const context = vi.fn(esbuild.context);
      const observedOptions = {
        ...options,
        esbuild: { ...esbuild, build, context }
      };
      expect(await validateCompileResolutions(observedOptions, manifest)).toBe(
        true
      );
      expect(build).not.toHaveBeenCalled();
      expect(context).toHaveBeenCalledTimes(1);
      expect(context.mock.calls[0]?.[0].stdin?.contents).toBe("");

      if (change === "extension")
        await writeFile(
          join(root, "app", "dep.ts"),
          'export const color="blue";'
        );
      else if (change === "nearer-package") {
        const nearer = join(root, "app", "node_modules", "theme-tokens");
        await mkdir(nearer, { recursive: true });
        await writeFile(join(nearer, "package.json"), '{"main":"index.js"}');
        await writeFile(join(nearer, "index.js"), 'export const color="blue";');
      } else
        await writeFile(
          join(packagePath, "package.json"),
          JSON.stringify({
            exports: change === "package-exports" ? "./blue.js" : "./red.js",
            sideEffects: false
          })
        );

      expect(await validateCompileResolutions(observedOptions, manifest)).toBe(
        false
      );
      expect(build).not.toHaveBeenCalled();
    }
  );

  it("retains native alias priority instead of recursively rewriting alias targets", async () => {
    const options = await fixture('export {color} from "first";');
    for (const [name, color] of [
      ["second", "red"],
      ["third", "blue"]
    ]) {
      const directory = join(options.cwd!, "node_modules", name!);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "package.json"), '{"main":"index.js"}');
      await writeFile(
        join(directory, "index.js"),
        `export const color="${color}";`
      );
    }
    options.alias = { first: "second", second: "third" };
    const manifest = await capture(options);
    expect(manifest?.records[0]?.result.path).toContain("/second/index.js");
    expect(await validateCompileResolutions(options, manifest)).toBe(true);
  });

  it.each(["paths", "baseUrl"] as const)(
    "replays native tsconfig %s in each importer's resolution directory",
    async (setting) => {
      const options = await fixture('export {color} from "./nested/dep";');
      const directory = join(options.cwd!, "app", "nested");
      await mkdir(directory);
      await writeFile(
        join(directory, "dep.ts"),
        'export {color} from "tokens";'
      );
      for (const color of ["red", "blue"]) {
        await mkdir(join(directory, color));
        await writeFile(
          join(directory, color, "tokens.ts"),
          `export const color="${color}";`
        );
      }
      const configure = (color: string) =>
        writeFile(
          join(directory, "tsconfig.json"),
          JSON.stringify({
            compilerOptions:
              setting === "paths"
                ? { paths: { tokens: [`./${color}/tokens.ts`] } }
                : { baseUrl: `./${color}` }
          })
        );
      await configure("red");
      const manifest = await capture(options);
      expect(
        manifest?.records.find(({ request }) => request.specifier === "tokens")
      ).toMatchObject({
        request: { importer: join(directory, "dep.ts"), resolveDir: directory },
        result: { path: join(directory, "red", "tokens.ts") }
      });
      expect(await validateCompileResolutions(options, manifest)).toBe(true);
      await configure("blue");
      expect(await validateCompileResolutions(options, manifest)).toBe(false);
      const changed = await capture(options);
      expect(
        changed?.records.find(({ request }) => request.specifier === "tokens")
          ?.result.path
      ).toBe(join(directory, "blue", "tokens.ts"));
      expect(await validateCompileResolutions(options, changed)).toBe(true);
    }
  );

  it("records conditional import/require modes, attributes and external edges", async () => {
    const options = await fixture(`import {color} from "theme-tokens";
      import data from "./data.json" with {type:"json"};
      import fs from "node:fs";
      export const values=[color,require("theme-tokens").color,data,fs];`);
    const directory = join(options.cwd!, "node_modules", "theme-tokens");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      '{"exports":{"import":"./import.js","require":"./require.cjs"}}'
    );
    await writeFile(
      join(directory, "import.js"),
      'export const color="import";'
    );
    await writeFile(join(directory, "require.cjs"), 'exports.color="require";');
    await writeFile(join(options.cwd!, "app", "data.json"), '{"value":1}');
    const manifest = await capture(options);
    const calls =
      manifest?.records.filter(
        (record) => record.request.specifier === "theme-tokens"
      ) ?? [];
    expect(new Set(calls.map((record) => record.request.kind))).toEqual(
      new Set(["import-statement", "require-call"])
    );
    expect(new Set(calls.map((record) => record.result.path)).size).toBe(2);
    expect(
      manifest?.records.some((record) => record.request.with.type === "json")
    ).toBe(true);
    expect(
      manifest?.records.some(
        (record) => record.result.external && record.result.path === "node:fs"
      )
    ).toBe(true);
    expect(await validateCompileResolutions(options, manifest)).toBe(true);
  });

  it("keeps optional unresolved imports unchanged but marks their graph unknown", async () => {
    const options = await fixture(
      'let optional;try{optional=require("missing-optional");}catch{};export {optional};'
    );
    const manifest = await capture(options);
    expect(manifest).toBeUndefined();
    expect(await validateCompileResolutions(options, manifest)).toBe(false);
  });

  it.each([
    [
      "decorators",
      "const sealed = (value: unknown) => value; export @sealed class Factory {}"
    ],
    [
      "class-private-field",
      "export class Factory { #value = 1; value() { return this.#value; } }"
    ],
    ["object-rest-spread", "export const copy = value => ({ ...value });"]
  ])(
    "retains resolution proofs when lowering %s creates internal runtime helpers",
    async (syntax, source) => {
      const options = await fixture('export * from "./dependency.ts";');
      await writeFile(join(options.cwd!, "app", "dependency.ts"), source);
      const lower: Plugin = {
        name: "lower-syntax",
        setup(build) {
          build.initialOptions.supported = { [syntax]: false };
        }
      };
      const manifest = await capture(options, [lower]);
      expect(manifest).toBeDefined();
      expect(await validateCompileResolutions(options, manifest)).toBe(true);
    }
  );

  it("still records and revalidates a real external import named like the internal runtime", async () => {
    const options = await fixture('export * from "<runtime>";');
    options.externals = ["<runtime>"];
    const manifest = await capture(options);
    expect(manifest?.records).toHaveLength(1);
    expect(manifest?.records[0]?.request.specifier).toBe("<runtime>");
    expect(await validateCompileResolutions(options, manifest)).toBe(true);
    expect(
      await validateCompileResolutions({ ...options, externals: [] }, manifest)
    ).toBe(false);
  });

  it("retains resolution proofs through a query-bearing physical importer", async () => {
    const options = await fixture(
      'export { color } from "./dep.js?theme=dark";'
    );
    await writeFile(
      join(options.cwd!, "app", "dep.js"),
      'export { color } from "./leaf.js";'
    );
    await writeFile(
      join(options.cwd!, "app", "leaf.js"),
      'export const color = "red";'
    );
    const manifest = await capture(options);
    expect(manifest).toBeDefined();
    expect(await validateCompileResolutions(options, manifest)).toBe(true);
  });

  it("rejects glob graphs whose future imports are not in the observed edge set", async () => {
    const options = await fixture(
      "export const load=name=>import(`./parts/${name}.js`);"
    );
    await mkdir(join(options.cwd!, "app", "parts"));
    await writeFile(
      join(options.cwd!, "app", "parts", "red.js"),
      'export default "red";'
    );
    expect(await capture(options)).toBeUndefined();
  });

  it.each(["import", "require"])(
    "rejects an initially empty %s glob even when its warning is suppressed",
    async (loader) => {
      const options = await fixture(
        `export const load = name => ${loader}(\`./parts/\${name}.js\`);`
      );
      const directory = join(options.cwd!, "app", "parts");
      await mkdir(directory);
      const silence: Plugin = {
        name: "silence-empty-glob",
        setup(build) {
          build.initialOptions.logOverride = { "empty-glob": "silent" };
        }
      };
      const manifest = await capture(options, [silence]);
      expect(manifest).toBeUndefined();
      await writeFile(join(directory, "blue.js"), 'export default "blue";');
      expect(await validateCompileResolutions(options, manifest)).toBe(false);
      expect(await capture(options, [silence])).toBeUndefined();
    }
  );

  it("leaves opaque resolver hooks in their original order without double invocation", async () => {
    const options = await fixture('export {color} from "virtual-theme";');
    const resolve = vi.fn(() => ({ path: "theme", namespace: "virtual" }));
    const plugin: Plugin = {
      name: "opaque-resolver",
      setup(build) {
        build.onResolve({ filter: /^virtual-theme$/ }, resolve);
        build.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({
          contents: 'export const color="red";',
          loader: "js"
        }));
      }
    };
    expect(await capture(options, [plugin])).toBeUndefined();
    // One ordinary build and one observed build, each invokes the hook once.
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("does not trust plugin data hidden behind an onLoad-only bridge", async () => {
    const options = await fixture('export {color} from "./dep.js";');
    await writeFile(
      join(options.cwd!, "app", "dep.js"),
      'export {color} from "./leaf.js";'
    );
    await writeFile(
      join(options.cwd!, "app", "leaf.js"),
      'export const color="red";'
    );
    const plugin: Plugin = {
      name: "opaque-load-context",
      setup(build) {
        build.onLoad({ filter: /dep\.js$/ }, () => ({
          contents: 'export {color} from "./leaf.js";',
          loader: "js",
          resolveDir: join(options.cwd!, "app"),
          pluginData: { hidden: true }
        }));
      }
    };
    expect(await capture(options, [plugin])).toBeUndefined();
  });

  it("revalidates host-resolved mappings from their lexical path", async () => {
    const options = await fixture('export {color} from "virtual-theme";');
    const root = options.cwd!;
    await writeFile(join(root, "red.js"), 'export const color="red";');
    await writeFile(join(root, "blue.js"), 'export const color="blue";');
    const link = join(root, "current.js");
    await symlink(join(root, "red.js"), link);
    options.resolvedImports = { "virtual-theme": link };
    const manifest = await capture(options);
    expect(await validateCompileResolutions(options, manifest)).toBe(true);
    await rm(link);
    await symlink(join(root, "blue.js"), link);
    expect(await validateCompileResolutions(options, manifest)).toBe(false);
  });
});
