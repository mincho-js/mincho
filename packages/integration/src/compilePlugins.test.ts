import esbuild from "esbuild";
import { processDefineRulesPresetRegistryFile } from "./defineRulesPreset.js";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { runInNewContext } from "node:vm";
import * as vanillaCss from "@vanilla-extract/css";
import * as vanillaFileScope from "@vanilla-extract/css/fileScope";
import { addFileScope } from "@vanilla-extract/integration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile } from "./compile.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "mincho-child-plugins-"))
  );
  roots.push(root);
  await fs.writeFile(join(root, "package.json"), '{"name":"child-fixture"}');
  const dependency = join(root, "dependency.custom");
  await fs.writeFile(
    dependency,
    "This disk source must be replaced by the caller loader."
  );
  return { root, dependency };
}

describe("caller loaders in child compilation", () => {
  it.each([false, true])(
    "retains virtual public APIs without granting artifact provenance (emits: %s)",
    async (emits) => {
      await fs.mkdir(join(process.cwd(), ".cache"), { recursive: true });
      const root = await fs.mkdtemp(join(process.cwd(), ".cache/virtual-api-"));
      roots.push(root);
      await fs.writeFile(join(root, "package.json"), '{"name":"virtual-api"}');
      const filePath = join(root, "entry.js");
      const result = await compile({
        cwd: root,
        filePath,
        originalPath: filePath,
        resolverCache: new Map(),
        contents: `export {value} from 'virtual:tokens';`,
        plugins: [
          {
            name: "virtual-scope-reader",
            setup(build) {
              build.onResolve({ filter: /^virtual:tokens$/ }, () => ({
                path: "tokens",
                namespace: "virtual-tokens"
              }));
              build.onLoad(
                { filter: /.*/, namespace: "virtual-tokens" },
                () => ({
                  contents: emits
                    ? `import {setFileScope,endFileScope} from '@vanilla-extract/css/fileScope';import {style} from '@vanilla-extract/css';setFileScope('virtual','virtual-api');export const value=style({color:'red'});endFileScope();`
                    : `import {hasFileScope} from '@vanilla-extract/css/fileScope';export const value=typeof hasFileScope();`,
                  loader: "js"
                })
              );
            }
          }
        ]
      });
      const serialized = vi.fn(() => "");
      const pending = processDefineRulesPresetRegistryFile({
        filePath,
        source: result.source,
        cssScopeOrigins: result.cssScopeOrigins,
        serializeCssArtifact: serialized
      });
      if (emits)
        await expect(pending).rejects.toThrow("Missing CSS scope provenance");
      else expect((await pending).source).toContain("boolean");
      expect(serialized).not.toHaveBeenCalled();
    }
  );

  it.each(["assert", "with"] as const)(
    "preserves caller-selected ESM import %s syntax in the emitted child bytes",
    async (keyword) => {
      const { root } = await fixture();
      const filePath = join(root, "entry.ts");
      let emittedSource = "";
      const result = await compile({
        cwd: root,
        filePath,
        originalPath: filePath,
        resolverCache: new Map(),
        externals: ["./theme.json"],
        contents: `import theme from "./theme.json" ${keyword} { type: "json" }; export const color = theme.color;`,
        esbuild: {
          ...esbuild,
          async build(options) {
            const output = await esbuild.build({
              ...options,
              format: "esm",
              supported: { "import-assertions": true }
            });
            emittedSource = output.outputFiles?.[0]?.text ?? "";
            return output;
          }
        }
      });
      expect(emittedSource).toContain(
        `from "./theme.json" ${keyword} { type: "json" };`
      );
      expect(result.source).toBe(emittedSource);
    }
  );

  it("preserves native ESM fileScope imports in an entry and its dependency", async () => {
    const cacheDir = join(process.cwd(), ".cache");
    await fs.mkdir(cacheDir, { recursive: true });
    const root = await fs.mkdtemp(join(cacheDir, "esm-file-scope-"));
    roots.push(root);
    const filePath = join(root, "entry.ts");
    await fs.writeFile(
      join(root, "helper.ts"),
      `import { hasFileScope } from "@vanilla-extract/css/fileScope";
      export function dependencyHasScope() { return hasFileScope(); }`
    );
    const result = await compile({
      cwd: root,
      filePath,
      originalPath: filePath,
      resolverCache: new Map(),
      contents: `
        import { hasFileScope } from "@vanilla-extract/css/fileScope";
        import { dependencyHasScope } from "./helper";
        export const scoped = [hasFileScope(), dependencyHasScope()];
      `,
      esbuild: {
        ...esbuild,
        build: (options) => esbuild.build({ ...options, format: "esm" })
      }
    });
    await fs.writeFile(join(root, "output.mjs"), result.source);
    const runner = join(root, "verify.mjs");
    await fs.writeFile(
      runner,
      'import { scoped } from "./output.mjs"; process.stdout.write(JSON.stringify(scoped));'
    );
    expect(execFileSync(process.execPath, [runner], { encoding: "utf8" })).toBe(
      "[false,false]"
    );
  });

  it.each([
    ["tokens.js", "default"],
    ["tokens.mjs", "default"],
    ["tokens.tsx", "default"],
    ["tokens.js", "js"],
    ["tokens.js", undefined]
  ] as const)(
    "records the physical CSS producer for caller-loaded %s with loader %s",
    async (filename, loader) => {
      const cacheDir = join(process.cwd(), ".cache");
      await fs.mkdir(cacheDir, { recursive: true });
      const root = await fs.realpath(
        await fs.mkdtemp(join(cacheDir, "default-script-loader-"))
      );
      roots.push(root);
      await fs.writeFile(
        join(root, "package.json"),
        '{"name":"default-script-loader"}'
      );
      const filePath = join(root, "entry.ts");
      const dependency = join(root, filename);
      await fs.writeFile(dependency, "// Supplied by the loader.");
      const result = await compile({
        cwd: root,
        filePath,
        originalPath: filePath,
        resolverCache: new Map(),
        contents: `export { token } from "./${filename}";`,
        plugins: [
          {
            name: "load-scoped-token",
            setup(build) {
              build.onLoad({ filter: /tokens\.(?:m?js|tsx)$/ }, () => ({
                contents: `
                  import {globalStyle} from "@vanilla-extract/css";
                  import {setFileScope,endFileScope} from "@vanilla-extract/css/fileScope";
                  setFileScope(${JSON.stringify(filename)}, "default-script-loader");
                  globalStyle(".loader-token",{color:"green"});
                  endFileScope();
                  export const token${filename.endsWith(".tsx") ? ": string" : ""} = "ready";
                `,
                loader
              }));
            }
          }
        ]
      });
      const serializeCssArtifact = vi.fn(() => "");
      const evaluated = await processDefineRulesPresetRegistryFile({
        filePath,
        ...result,
        serializeCssArtifact
      });
      expect(evaluated.source).toContain("export var token = 'ready';");
      expect(serializeCssArtifact).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          origin: dependency,
          cssObjs: [
            {
              type: "global",
              selector: ".loader-token",
              rule: { color: "green" }
            }
          ]
        })
      );
    }
  );

  it("keeps a caller-loaded CSS resource with an effective non-script loader untouched", async () => {
    const { root } = await fixture();
    const filePath = join(root, "entry.ts");
    const dependency = join(root, "resource.css");
    await fs.writeFile(dependency, "unused disk contents");
    const loader = { ".css": "text" } as const;
    const payload = ".ordinary { color: green; }";
    const result = await compile({
      cwd: root,
      filePath,
      originalPath: filePath,
      resolverCache: new Map(),
      contents: 'export {default as text} from "./resource.css";',
      loader,
      plugins: [
        {
          name: "load-css-as-text",
          setup(build) {
            build.onLoad({ filter: /resource\.css$/ }, () => ({
              loader: "default",
              contents: payload
            }));
          }
        }
      ]
    });
    const module = { exports: {} as { text?: string } };
    runInNewContext(result.source, {
      module,
      exports: module.exports,
      require: () => vanillaFileScope
    });
    expect(module.exports.text).toBe(payload);
    expect(result.cssScopeOrigins).not.toContainEqual(
      expect.objectContaining({ origin: dependency })
    );
  });

  it("parses sloppy CommonJS output using its emitted grammar", async () => {
    const { root } = await fixture();
    const filePath = join(root, "entry.cjs");
    const result = await compile({
      cwd: root,
      filePath,
      originalPath: filePath,
      resolverCache: new Map(),
      contents: `with ({answer:42}) { module.exports.answer=answer; }`
    });
    const module = { exports: {} as { answer?: number } };
    runInNewContext(result.source, {
      module,
      exports: module.exports,
      require: () => vanillaFileScope
    });
    expect(module.exports.answer).toBe(42);
  });

  it("preserves caller fileScope resolver selection in direct execution", async () => {
    const { root } = await fixture();
    const selected = vi.fn();
    const result = await compile({
      cwd: root,
      filePath: join(root, "entry.js"),
      originalPath: join(root, "entry.js"),
      resolverCache: new Map(),
      contents: `const scope=require('@vanilla-extract/css/fileScope');export const selected=scope.getFileScope().filePath;`,
      plugins: [
        {
          name: "caller-file-scope",
          setup(build) {
            build.onResolve(
              { filter: /^@vanilla-extract\/css\/fileScope$/ },
              () => {
                selected();
                return { path: "caller-owned-scope", external: true };
              }
            );
          }
        }
      ]
    });
    const module = { exports: {} as { selected: string } };
    runInNewContext(result.source, {
      module,
      exports: module.exports,
      require(id: string) {
        if (id === "caller-owned-scope")
          return { getFileScope: () => ({ filePath: "caller-selected" }) };
        throw new Error("Unexpected " + id);
      }
    });
    expect(selected).toHaveBeenCalledOnce();
    expect(module.exports.selected).toBe("caller-selected");
  });

  it("does not grant artifact authority to a caller-overridden fileScope API", async () => {
    await fs.mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await fs.mkdtemp(
      join(process.cwd(), ".cache/override-scope-")
    );
    roots.push(root);
    await fs.writeFile(join(root, "package.json"), '{"name":"scope-override"}');
    const alternate = join(root, "alternate-scope.cjs");
    await fs.writeFile(
      alternate,
      'module.exports = require("@vanilla-extract/css/fileScope");'
    );
    const filePath = join(root, "entry.js");
    const selected = vi.fn();
    const result = await compile({
      cwd: root,
      filePath,
      originalPath: filePath,
      resolverCache: new Map(),
      contents: `const scope=require('@vanilla-extract/css/fileScope');const {style}=require('@vanilla-extract/css');scope.setFileScope('custom.css.ts','custom');exports.cls=style({color:'red'});scope.endFileScope();`,
      plugins: [
        {
          name: "caller-file-scope",
          setup(build) {
            build.onResolve(
              { filter: /^@vanilla-extract\/css\/fileScope$/ },
              () => {
                selected();
                return { path: alternate, external: true };
              }
            );
          }
        }
      ]
    });
    const artifact = vi.fn(() => "");
    await expect(
      processDefineRulesPresetRegistryFile({
        filePath,
        source: result.source,
        cssScopeOrigins: result.cssScopeOrigins,
        serializeCssArtifact: artifact
      })
    ).rejects.toThrow("Missing CSS scope provenance");
    expect(selected).toHaveBeenCalledOnce();
    expect(artifact).not.toHaveBeenCalled();
  });

  it("loads generated dependencies outside a named package", async () => {
    const { root } = await fixture();
    const generated = await fs.mkdtemp(join(tmpdir(), "mincho-generated-"));
    roots.push(generated);
    const dependency = join(generated, "tokens.ts");
    await fs.writeFile(
      join(root, "color.ts"),
      'export const color = "royalblue";'
    );

    const compiled = await compile({
      cwd: root,
      filePath: join(root, "entry.ts"),
      originalPath: join(root, "entry.ts"),
      contents: 'export { value } from "virtual:tokens";',
      // Control the absence contract instead of inheriting /tmp's ancestors.
      readPackageFile: async (path) =>
        path === join(root, "package.json")
          ? fs.readFile(path, "utf8")
          : undefined,
      resolverCache: new Map(),
      plugins: [
        {
          name: "generated-tokens",
          setup(build) {
            build.onResolve({ filter: /^virtual:tokens$/ }, () => ({
              path: dependency,
              namespace: "file"
            }));
            build.onLoad({ filter: /tokens\.ts$/ }, () => ({
              contents:
                'import { color } from "./color.ts"; export const value: string = color;',
              loader: "ts",
              resolveDir: root
            }));
          }
        }
      ]
    });
    const module = { exports: {} as { value: string } };
    runInNewContext(compiled.source, {
      module,
      exports: module.exports,
      require(id: string) {
        if (id === "@vanilla-extract/css/fileScope") return vanillaFileScope;
        throw new Error(`Unexpected dependency: ${id}`);
      }
    });

    expect(module.exports.value).toBe("royalblue");
    expect(compiled.source).toContain(
      JSON.stringify(
        relative(root, dependency)
          .split(sep)
          .map((segment) =>
            segment === ".." ? "%2E%2E" : encodeURIComponent(segment)
          )
          .join("/")
      )
    );
    expect(vanillaFileScope.hasFileScope()).toBe(false);
  });

  it.each(["tsx", undefined] as const)(
    "scopes and transforms caller contents with loader %s",
    async (loader) => {
      const { root, dependency } = await fixture();
      const resolveDir = join(root, "loaded");
      await fs.mkdir(resolveDir);
      await fs.writeFile(
        join(resolveDir, "color.ts"),
        'export const color = "red";'
      );
      const pluginData = { loaded: true };
      const resolved = vi.fn();
      const skipped = vi.fn();
      const contents = `import { styled } from "@mincho-js/react";
      import { color } from "./color.ts";
      export const Box = styled("div", { color });
      ${loader ? 'export const view = <div title="loaded" />;' : ""}`;

      const compiled = await compile({
        cwd: root,
        filePath: join(root, "entry.tsx"),
        originalPath: join(root, "entry.tsx"),
        contents: 'export { Box } from "./dependency.custom";',
        resolverCache: new Map(),
        externals: ["@mincho-js/react", "@mincho-js/react/runtime"],
        loader: { ".custom": "text" },
        plugins: [
          {
            name: "caller-loader",
            async setup(build) {
              await Promise.resolve();
              build.onLoad(
                { filter: /\.custom$/, namespace: "file" },
                () => undefined
              );
              build.onLoad({ filter: /\.custom$/, namespace: "file" }, () => ({
                contents: loader
                  ? new TextEncoder().encode(contents)
                  : contents,
                ...(loader ? { loader } : {}),
                resolveDir,
                pluginData
              }));
              build.onLoad({ filter: /\.custom$/, namespace: "file" }, skipped);
              build.onResolve({ filter: /^\.\/color\.ts$/ }, (args) => {
                resolved(args.pluginData);
                return undefined;
              });
            }
          }
        ]
      });

      expect(compiled.source).toContain(
        JSON.stringify(relative(root, dependency))
      );
      expect(compiled.source).toContain("$$styled");
      expect(compiled.source).toContain('var color = "red"');
      expect(compiled.watchFiles).toContain(dependency);
      expect(compiled.watchFiles).toContain(join(resolveDir, "color.ts"));
      expect(resolved).toHaveBeenCalledWith(pluginData);
      expect(skipped).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      namespace: "file",
      loader: "text",
      contents: "raw non-JavaScript contents"
    },
    {
      namespace: "virtual",
      loader: "js",
      contents: 'export default "virtual contents";'
    }
  ] as const)(
    "preserves $namespace contents with the $loader loader",
    async ({ namespace, loader, contents }) => {
      const { root, dependency } = await fixture();
      const compiled = await compile({
        cwd: root,
        filePath: join(root, "entry.tsx"),
        originalPath: join(root, "entry.tsx"),
        contents: 'export { default } from "./dependency.custom";',
        resolverCache: new Map(),
        plugins: [
          {
            name: "caller-loader",
            setup(build) {
              build.onResolve({ filter: /\.custom$/ }, () => ({
                path: dependency,
                namespace
              }));
              build.onLoad({ filter: /\.custom$/, namespace }, () => ({
                contents,
                loader,
                resolveDir: dirname(dependency)
              }));
            }
          }
        ]
      });
      expect(compiled.source).toContain(
        namespace === "file" ? contents : "virtual contents"
      );
      expect(
        compiled.cssScopeOrigins.some((entry) => entry.origin === dependency)
      ).toBe(false);
      expect(compiled.source).not.toContain(
        JSON.stringify(relative(root, dependency))
      );
    }
  );
});

describe("CommonJS dependencies in child compilation", () => {
  function evaluate(source: string) {
    const events: string[] = [];
    const module = { exports: {} as { load?: () => void; value?: string } };
    runInNewContext(source, {
      module,
      exports: module.exports,
      events,
      require(id: string) {
        if (id === "@vanilla-extract/css/fileScope")
          return {
            setFileScope() {},
            endFileScope() {},
            hasFileScope: () => false,
            getAndIncrementRefCounter: () => 0
          };
        if (id === "lazy-package") {
          events.push("lazy");
          return {};
        }
        throw new Error(`Unexpected dependency: ${id}`);
      }
    });

    return { events, exports: module.exports };
  }

  it("preserves statements before a late CommonJS dependency", async () => {
    const { root } = await fixture();
    await fs.writeFile(
      join(root, "dependency.cjs"),
      'exports.value = events.join(",");'
    );

    const compiled = await compile({
      filePath: join(root, "entry.cjs"),
      originalPath: join(root, "entry.cjs"),
      contents:
        'events.push("ready"); module.exports = require("./dependency.cjs");',
      cwd: root,
      resolverCache: new Map()
    });

    expect(evaluate(compiled.source).exports.value).toBe("ready");
  });

  it.each([false, true])(
    "restores parent identifiers across nested and repeated CommonJS dependencies (pre-scoped: %s)",
    async (prescoped) => {
      const { root } = await fixture();
      const entry = join(root, "entry.cjs");
      const child = join(root, "child.cjs");
      const styles = `const { style } = require("@vanilla-extract/css");
      exports.first = style({color: "red"});
      exports.second = style({color: "blue"});
      exports.third = style({color: "green"});`;

      const childSource = styles.replace(
        "exports.second =",
        'exports.grandchild = require("./grandchild.cjs"); exports.second ='
      );
      await fs.writeFile(join(root, "grandchild.cjs"), styles);
      await fs.writeFile(
        child,
        prescoped
          ? addFileScope({
              source: childSource,
              filePath: child,
              rootPath: root,
              packageName: "child-fixture"
            })
          : childSource
      );

      async function run(file: string, contents: string) {
        const compiled = await compile({
          filePath: file,
          originalPath: file,
          contents,
          cwd: root,
          resolverCache: new Map()
        });
        const module = { exports: {} as Record<string, unknown> };
        runInNewContext(compiled.source, {
          module,
          exports: module.exports,
          require(id: string) {
            if (id === "@vanilla-extract/css") return vanillaCss;
            if (id === "@vanilla-extract/css/fileScope")
              return vanillaFileScope;
            throw new Error(`Unexpected dependency: ${id}`);
          }
        });
        expect(vanillaFileScope.hasFileScope()).toBe(false);
        expect(vanillaFileScope.getAndIncrementRefCounter()).toBe(0);

        return module.exports;
      }

      const expectedEntry = await run(entry, styles);
      const expectedChild = await run(child, styles);
      const result = await run(
        entry,
        styles
          .replace(
            "exports.second =",
            'const fileScope = 1, parentCounter = 2, index = 3; exports.child = require("./child.cjs"); exports.second ='
          )
          .replace(
            "exports.third =",
            'exports.repeated = require("./child.cjs"); exports.locals = [fileScope, parentCounter, index]; exports.third ='
          )
      );

      expect(result).toMatchObject(expectedEntry);
      expect(result.child).toMatchObject(expectedChild);
      expect(result.repeated).toBe(result.child);
      expect(result.locals).toEqual([1, 2, 3]);
    }
  );

  it("leaves tsconfig-enabled entry syntax for esbuild", async () => {
    const { root } = await fixture();
    await fs.writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { experimentalDecorators: true } })
    );
    const compiled = await compile({
      filePath: join(root, "entry.ts"),
      originalPath: join(root, "entry.ts"),
      contents: `
        require("lazy-package");
        function mark(_target: unknown, _key: unknown, index: number) {
          events.push(String(index));
        }
        class Example { constructor(@mark value: string) {} }
        exports.value = new Example("ok").constructor.name;
      `,
      cwd: root,
      resolverCache: new Map(),
      externals: ["lazy-package"],
      plugins: [
        {
          name: "project-tsconfig",
          setup(build) {
            build.initialOptions.tsconfig = join(root, "tsconfig.json");
          }
        }
      ]
    });
    const result = evaluate(compiled.source);

    expect(result.exports.value).toBe("Example");
    expect(result.events).toEqual(["lazy", "0"]);
  });

  it("reports invalid entry syntax through esbuild", async () => {
    const { root } = await fixture();

    await expect(
      compile({
        filePath: join(root, "entry.ts"),
        originalPath: join(root, "entry.ts"),
        contents: 'require("lazy-package"); const value = ;',
        cwd: root,
        resolverCache: new Map(),
        externals: ["lazy-package"]
      })
    ).rejects.toThrow(/Unexpected/);
  });

  it.each(["entry", "dependency"])(
    "keeps optional and lazy requires guarded in the %s",
    async (location) => {
      const { root, dependency } = await fixture();
      const guarded = `
        try { require("missing-optional-package"); } catch {}
        exports.load = () => require("lazy-package");
        if (false) require("unreachable-package");
        class Unused { value = require("lazy-package"); }
        events.push("evaluated");
      `;
      await fs.writeFile(dependency, guarded);
      const compiled = await compile({
        filePath: join(root, "entry.cjs"),
        originalPath: join(root, "entry.cjs"),
        contents:
          location === "entry"
            ? guarded
            : 'module.exports = require("./dependency.custom");',
        cwd: root,
        resolverCache: new Map(),
        loader: { ".custom": "js" },
        externals: ["lazy-package"]
      });
      const result = evaluate(compiled.source);

      expect(result.events).toEqual(["evaluated"]);
      result.exports.load!();
      expect(result.events).toEqual(["evaluated", "lazy"]);
    }
  );

  it.each(["ts", "cts", "custom", "loaded"])(
    "parses %s dependencies with their actual TypeScript loader",
    async (extension) => {
      const { root } = await fixture();
      const dependency = join(root, `assertion.${extension}`);
      const contents =
        '// require is only a comment\nexport const value = <string>"ok";';
      await fs.writeFile(dependency, contents);
      const compiled = await compile({
        filePath: join(root, "entry.tsx"),
        originalPath: join(root, "entry.tsx"),
        contents: `export { value } from "./assertion.${extension}";`,
        cwd: root,
        resolverCache: new Map(),
        loader: { ".custom": "ts" },
        plugins:
          extension === "loaded"
            ? [
                {
                  name: "caller-typescript",
                  setup(build) {
                    build.onLoad({ filter: /\.loaded$/ }, () => ({
                      contents,
                      loader: "ts"
                    }));
                  }
                }
              ]
            : []
      });

      expect(evaluate(compiled.source).exports.value).toBe("ok");
      expect(compiled.watchFiles).toContain(dependency);
    }
  );

  it("does not resolve type-only import-equals dependencies", async () => {
    const { root } = await fixture();
    await fs.writeFile(
      join(root, "types.cts"),
      'import T = require("missing-type-package"); export const value: T = "ok";'
    );
    const compiled = await compile({
      filePath: join(root, "entry.tsx"),
      originalPath: join(root, "entry.tsx"),
      contents: 'export { value } from "./types.cts";',
      cwd: root,
      resolverCache: new Map()
    });

    expect(evaluate(compiled.source).exports.value).toBe("ok");
    expect(compiled.source).not.toContain("missing-type-package");
  });

  it("does not resolve type-only import-equals dependencies alongside JSX", async () => {
    const { root } = await fixture();
    await fs.writeFile(
      join(root, "types.tsx"),
      'import T = require("missing-type-package"); type Value = T.Member; const view = <div />; export const value = "ok";'
    );
    const compiled = await compile({
      filePath: join(root, "entry.tsx"),
      originalPath: join(root, "entry.tsx"),
      contents: 'export { value } from "./types.tsx";',
      cwd: root,
      resolverCache: new Map()
    });

    expect(evaluate(compiled.source).exports.value).toBe("ok");
    expect(compiled.source).not.toContain("missing-type-package");
  });
});

it("keeps public fileScope require.resolve external without an unused facade", async () => {
  const { root } = await fixture();
  const result = await compile({
    esbuild: {
      ...esbuild,
      build: async (options) => {
        const result = await esbuild.build(options);
        expect(result.warnings).toEqual([]);
        return result;
      }
    },
    cwd: root,
    filePath: join(root, "entry.css.js"),
    originalPath: join(root, "entry.js"),
    contents: `module.exports.path=require.resolve('@vanilla-extract/css/fileScope');`,
    resolverCache: new Map()
  });
  const resolve = vi.fn(() => "official-path");
  const requireModule = vi.fn((name) =>
    name === "@vanilla-extract/css/fileScope" ? vanillaFileScope : undefined
  );
  const module = { exports: {} as { path?: string } };
  runInNewContext(result.source, {
    module,
    exports: module.exports,
    require: Object.assign(requireModule, { resolve })
  });
  expect(module.exports.path).toBe("official-path");
  expect(resolve).toHaveBeenCalledWith("@vanilla-extract/css/fileScope");
  // This source contains no CSS authoring, so the compiler needs no wrapper.
  expect(requireModule).not.toHaveBeenCalled();
});

it.each([true, false])(
  "retains producer attribution when a caller externalizes the unchanged official API (explicit path: %s)",
  async (explicitPath) => {
    await fs.mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await fs.mkdtemp(
      join(process.cwd(), ".cache/external-scope-")
    );
    roots.push(root);
    await fs.writeFile(join(root, "package.json"), '{"name":"external-scope"}');
    const filePath = join(root, "entry.js");
    const observed = vi.fn();
    const result = await compile({
      cwd: root,
      filePath,
      originalPath: filePath,
      contents: `import {style} from '@vanilla-extract/css';export const value=style({color:'red'});`,
      resolverCache: new Map(),
      plugins: [
        {
          name: "public-external",
          setup(build) {
            build.onResolve(
              { filter: /^@vanilla-extract\/css\/fileScope$/ },
              (args) => {
                observed(args.importer);
                return {
                  ...(explicitPath ? { path: args.path } : {}),
                  external: true
                };
              }
            );
          }
        }
      ]
    });
    const artifacts: Array<{ origin: string }> = [];
    await processDefineRulesPresetRegistryFile({
      filePath,
      source: result.source,
      cssScopeOrigins: result.cssScopeOrigins,
      serializeCssArtifact(artifact) {
        artifacts.push(artifact);
        return "";
      }
    });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.origin).toBe(filePath);
  }
);

it("accepts emitted CommonJS top-level return without weakening capability checks", async () => {
  const { root } = await fixture();
  const filePath = join(root, "entry.cjs");
  const result = await compile({
    cwd: root,
    filePath,
    originalPath: filePath,
    contents: "exports.answer=42; return; exports.answer=0;",
    resolverCache: new Map(),
    plugins: [
      {
        name: "preserve-return",
        setup(build) {
          build.initialOptions.banner = { js: "if (false) return;" };
        }
      }
    ]
  });
  // Let Node apply its CommonJS wrapper in a separate process: an early
  // return may leave that process's file-scope stack open.
  const cacheDir = join(process.cwd(), ".cache");
  await fs.mkdir(cacheDir, { recursive: true });
  const outputDir = await fs.mkdtemp(join(cacheDir, "commonjs-return-"));
  roots.push(outputDir);
  const runnerPath = join(outputDir, "verify.cjs");
  await fs.writeFile(join(outputDir, "compile-output.cjs"), result.source);
  await fs.writeFile(
    runnerPath,
    'process.stdout.write(JSON.stringify(require("./compile-output.cjs").answer));'
  );
  expect(
    execFileSync(process.execPath, [runnerPath], { encoding: "utf8" })
  ).toBe("42");
});
