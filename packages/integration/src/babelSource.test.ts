import { describe, expect, it, onTestFinished as afterTest, vi } from "vitest";
import { parseSync, type PluginObj } from "@babel/core";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BabelTransformError,
  babelTransform,
  babelTransformSource
} from "./babel.js";
import { MinchoProjectEngine } from "./staticCssEvalProjectEngine.js";
import { CompilationCache } from "./compilationCache.js";
import { CompilationDiagnostics } from "./diagnostics.js";
import { typescriptPresetPath } from "./babelPreset.js";

const filename = "/virtual/mincho-owner.tsx";
const source =
  'export const marker = "incoming"; export const App = () => <div css={{color: "red"}} />;';

function seedArtifacts(engine: MinchoProjectEngine) {
  engine.refreshFile({
    fileId: filename,
    result: { dependencyFiles: ["/stale.ts"] },
    generatedArtifacts: [
      {
        ownerFile: filename,
        artifactFile: "stale.css.ts",
        source: "stale",
        kind: "sidecar-css-ts"
      }
    ]
  });
}

describe("babelTransformSource", () => {
  it.each([
    "default",
    "plugin",
    "preset",
    "configuration",
    "override"
  ] as const)(
    "honors %s-enabled Flow syntax with a configured JSX source",
    async (syntax) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-flow-source-"));
      afterTest(() => rm(root, { recursive: true, force: true }));

      const visitType = vi.fn();
      const parserOverride = vi.fn((code: string) =>
        parseSync(code, {
          babelrc: false,
          configFile: false,
          parserOpts: { plugins: ["flow", "jsx"] }
        })
      );
      const flowSyntax = (): PluginObj => ({
        manipulateOptions(_options, parser) {
          parser.plugins.push("flow");
        },
        visitor: {
          TypeAlias(path) {
            visitType();
            path.remove();
          }
        },
        ...(syntax === "override" ? { parserOverride } : {})
      });
      const flowPreset = () => ({ plugins: [flowSyntax] });
      const configFile = join(root, "babel.config.cjs");

      if (syntax === "configuration") {
        await writeFile(
          configFile,
          `module.exports = { presets: [() => ({ plugins: [() => ({
            manipulateOptions(_options, parser) { parser.plugins.push("flow"); },
            visitor: { TypeAlias(path) { path.remove(); } }
          })] })] };`
        );
      }

      const transformed = await babelTransformSource({
        filename: join(root, "entry.jsx"),
        root,
        source: `
          type Palette = {| color: string |};
          export const App = () => <div css={{ color: "red" }} />;
        `,
        babel: {
          configFile: syntax === "configuration" ? configFile : false,
          babelrc: false,
          plugins:
            syntax === "plugin" || syntax === "default" || syntax === "override"
              ? [flowSyntax]
              : [],
          presets: syntax === "preset" ? [flowPreset] : [],
          jsxCssProp:
            syntax === "default" ? true : { importSource: "custom-styles" },
          optimize: { pureFunctions: false }
        }
      });

      expect(transformed.jsxCssPropTransformed).toBe(true);
      expect(transformed.code).not.toContain("type Palette");
      expect(transformed.code).not.toContain("css=");
      expect(transformed.result[1]).toContain('color: "red"');
      expect(transformed.result[1]).toContain(
        syntax === "default" ? 'from "@mincho-js/css"' : 'from "custom-styles"'
      );

      if (syntax !== "configuration") expect(visitType).toHaveBeenCalledOnce();
      if (syntax === "override") expect(parserOverride).toHaveBeenCalledOnce();
    }
  );

  it("preserves configured parser failures when extraction parsing falls back", async () => {
    const parserOverride = vi.fn(() => {
      throw new Error("configured parser failed");
    });

    await expect(
      babelTransformSource({
        filename: "/virtual/entry.jsx",
        source:
          'type Palette = {| color: string |}; export const App = () => <div css={{ color: "red" }} />;',
        babel: {
          configFile: false,
          babelrc: false,
          jsxCssProp: { importSource: "custom-styles" },
          plugins: [() => ({ parserOverride, visitor: {} })]
        }
      })
    ).rejects.toMatchObject({
      name: "BabelTransformError",
      message: expect.stringContaining("configured parser failed")
    });

    expect(parserOverride).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "normalizes TypeScript import-equals after configured syntax retry cached parsing=%s",
    async (cached) => {
      const visitDecorator = vi.fn();
      const transformed = await babelTransformSource({
        filename: "/virtual/entry.tsx",
        root: "/virtual",
        source: `
          import preset = require("./preset.ts");
          @sealed class View {}
          export const primary = preset.css({ color: "red" });
          export const shadowed = (preset: any) => preset.css({ color: "blue" });
          export { View };
        `,
        babel: {
          compilationCache: cached ? new CompilationCache() : undefined,
          configFile: false,
          babelrc: false,
          presets: [
            () => ({
              plugins: [
                (): PluginObj => ({
                  manipulateOptions(_options, parser) {
                    parser.plugins.push("decorators-legacy");
                  },
                  visitor: {
                    Decorator(path) {
                      visitDecorator();
                      path.remove();
                    }
                  }
                })
              ]
            })
          ],
          extractCalls: { "./preset.ts": ["css"] },
          staticCssEvalSourceProvider: {
            resolve: (_importer, specifier) =>
              specifier === "./preset.ts" ? { id: "/virtual/preset.ts" } : null,
            load: (id) =>
              id === "/virtual/preset.ts"
                ? {
                    source: `
                      import { style } from "@vanilla-extract/css";
                      export const css = (rule) => style(rule);
                    `
                  }
                : null
          }
        }
      });

      expect(transformed.result[1]).toContain('color: "red"');
      expect(transformed.code).not.toContain('color: "red"');
      expect(transformed.code).toContain('color: "blue"');
      expect(transformed.result[1]).not.toContain('color: "blue"');
      expect(transformed.code).not.toContain("@sealed");
      expect(visitDecorator).toHaveBeenCalledOnce();
    }
  );

  it.each([
    [false, "jsxPragma", "h", "<div />"],
    [true, "jsxPragma", "h", "<div />"],
    [false, "jsxPragmaFrag", "Fragment", "<></>"],
    [true, "jsxPragmaFrag", "Fragment", "<></>"]
  ] as const)(
    "preserves configured JSX imports after syntax retry (cached=%s, %s)",
    async (cached, option, binding, jsx) => {
      const visitDecorator = vi.fn();
      const transformed = await babelTransformSource({
        filename: "/virtual/pragma.tsx",
        root: "/virtual",
        source: `
          import ${binding} = require("classic-jsx");
          import T = require("unused-types");
          type Value = T.Member;
          @sealed class View {}
          export const view = ${jsx};
          export { View };
        `,
        babel: {
          compilationCache: cached ? new CompilationCache() : undefined,
          configFile: false,
          babelrc: false,
          extractCalls: { "custom-styles": ["css"] },
          presets: [
            () => ({
              presets: [[typescriptPresetPath, { [option]: binding }]],
              plugins: [
                (): PluginObj => ({
                  manipulateOptions(_options, parser) {
                    parser.plugins.push("decorators-legacy");
                  },
                  visitor: {
                    Decorator(path) {
                      visitDecorator();
                      path.remove();
                    }
                  }
                })
              ]
            })
          ]
        }
      });

      expect(transformed.code).toContain('require("classic-jsx")');
      expect(transformed.code).not.toContain("unused-types");
      expect(transformed.code).not.toContain("@sealed");
      expect(transformed.code).toContain("export const view");
      expect(visitDecorator).toHaveBeenCalledOnce();
    }
  );

  it("keeps local extraction bindings when a preset enables the owner syntax", async () => {
    const source = `
      import { style } from "@vanilla-extract/css";
      type Palette = {| color: string |};
      const make = (rule) => style(rule);
      export { make as registered };
      export const primary = make({ color: "red" });
      export const shadowed = (make) => make({ color: "blue" });
    `;
    const transformed = await babelTransformSource({
      filename: "/virtual/factory.jsx",
      root: "/virtual",
      source,
      babel: {
        configFile: false,
        babelrc: false,
        presets: [
          () => ({
            plugins: [
              (): PluginObj => ({
                manipulateOptions(_options, parser) {
                  parser.plugins.push("flow");
                },
                visitor: {}
              })
            ]
          })
        ],
        extractCalls: { "./factory.jsx": ["registered"] },
        staticCssEvalSourceProvider: {
          resolve: (_importer, specifier) =>
            specifier === "./factory.jsx"
              ? { id: "/virtual/factory.jsx" }
              : null,
          load: () => null
        }
      }
    });

    expect(transformed.result[1]).toContain('color: "red"');
    expect(transformed.result[1]).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain('color: "blue"');
    expect(transformed.code).not.toContain('color: "red"');
    expect(transformed.code).toContain('color: "blue"');
  });

  it.each([false, true])(
    "uses preset-enabled syntax in a registered dependency with owner syntax=%s",
    async (ownerUsesFlow) => {
      const visitType = vi.fn();
      const transformed = await babelTransformSource({
        filename: "/virtual/entry.jsx",
        root: "/virtual",
        source: `
          ${ownerUsesFlow ? "type Palette = {| color: string |};" : ""}
          import { make } from "./factory.js";
          export const primary = make({ color: "red" });
        `,
        babel: {
          configFile: false,
          babelrc: false,
          presets: [
            () => ({
              plugins: [
                (): PluginObj => ({
                  manipulateOptions(_options, parser) {
                    parser.plugins.push("flow");
                  },
                  visitor: {
                    TypeAlias(path) {
                      visitType();
                      path.remove();
                    }
                  }
                })
              ]
            })
          ],
          optimize: { pureFunctions: false },
          extractCalls: { "./factory.js": ["make"] },
          staticCssEvalSourceProvider: {
            resolve: (_importer, specifier) =>
              specifier === "./factory.js"
                ? { id: "/virtual/factory.js" }
                : null,
            load: (id) =>
              id === "/virtual/factory.js"
                ? {
                    source: `
                      import { style } from "@vanilla-extract/css";
                      type Palette = {| color: string |};
                      export const make = (rule: Palette) => style(rule);
                    `
                  }
                : null
          }
        }
      });

      expect(transformed.result[1]).toContain('color: "red"');
      expect(transformed.code).not.toContain('color: "red"');
      expect(transformed.code).not.toContain("type Palette");
      expect(visitType).toHaveBeenCalledTimes(ownerUsesFlow ? 1 : 0);
      expect(transformed.staticCssEval?.dependencyFiles).toContain(
        "/virtual/factory.js"
      );
    }
  );

  it("automatically extracts configured JSX css sources and isolates cached source choices", async ({
    onTestFinished
  }) => {
    const root = await mkdtemp(join(tmpdir(), "mincho-jsx-css-source-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const filename = join(root, "entry.tsx");
    const source = `export const Button = () => <button css={[{bg: "blue", px: 3}, "rounded"]} />;`;
    await writeFile(filename, source);
    const cache = new CompilationCache();
    const diagnostics = new CompilationDiagnostics({ console: true });
    const transform = (importSource: string) =>
      diagnostics.run(filename, "transform", () =>
        babelTransformSource({
          filename,
          root,
          source,
          loader: "tsx",
          babel: {
            jsxCssProp: { importSource },
            compilationCache: cache,
            staticCssEvalSourceProvider: {
              resolve: () => null,
              load: () => null
            }
          }
        })
      );

    const first = await transform("first-preset");
    const second = await transform("second-preset");
    const repeated = await transform("first-preset");

    expect(first.result[1]).toContain('from "first-preset"');
    expect(second.result[1]).toContain('from "second-preset"');
    expect(first.result[0]).not.toBe(second.result[0]);
    expect(repeated.result).toEqual(first.result);
    expect(repeated.code).toEqual(first.code);
    expect(first.code).not.toContain("first-preset");
    expect(first.jsxCssPropTransformed).toBe(true);
    expect(first.result[1]).toContain('"rounded"');
    expect(
      diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events)
        .filter((event) => event.phase === "cache-hit")
    ).toHaveLength(1);
  });

  it.each(["cwd", "root", "default"] as const)(
    "observes a sibling Babel configuration selected through %s",
    async (selection) => {
      const directory = await mkdtemp(join(tmpdir(), "mincho-babel-root-"));
      const project = join(directory, "project");
      const sourceRoot = join(directory, "source");
      const config = join(project, "babel.config.json");
      const cwd =
        selection === "default"
          ? vi.spyOn(process, "cwd").mockReturnValue(project)
          : undefined;

      try {
        await Promise.all([mkdir(project), mkdir(sourceRoot)]);
        for (const color of ["blue", "green"]) {
          await writeFile(
            join(project, `${color}.cjs`),
            `module.exports = () => ({ parserOverride(code, options, parse) { return parse(code.replace('"red"', '"${color}"'), options); } });`
          );
        }

        const options = {
          filename: join(sourceRoot, "entry.ts"),
          source:
            'import { css } from "@mincho-js/css"; export const cls = css({ color: "red" });',
          babel: {
            compilationCache: new CompilationCache(),
            ...(selection === "cwd" ? { cwd: project } : {}),
            ...(selection === "root" ? { cwd: directory, root: "project" } : {})
          }
        };

        expect((await babelTransformSource(options)).result[1]).toContain(
          '"red"'
        );
        expect((await babelTransformSource(options)).result[1]).toContain(
          '"red"'
        );

        for (const color of ["blue", "green"]) {
          await writeFile(
            config,
            JSON.stringify({ plugins: [join(project, `${color}.cjs`)] })
          );
          expect((await babelTransformSource(options)).result[1]).toContain(
            `"${color}"`
          );
        }

        await rm(config);
        expect((await babelTransformSource(options)).result[1]).toContain(
          '"red"'
        );
      } finally {
        cwd?.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("honors an automatically discovered ESM Babel parser configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "mincho-parser-config-"));

    try {
      await writeFile(join(root, "package.json"), '{"name":"parser-config"}');
      await writeFile(
        join(root, ".babelrc.mjs"),
        'export default { plugins: [() => ({ parserOverride(code, options, parse) { return parse(code.replace("red", "blue"), options); } })] };'
      );

      const result = await babelTransformSource({
        filename: join(root, "entry.ts"),
        root,
        source:
          'import { css } from "@mincho-js/css"; export const cls = css({ color: "red" });',
        babel: { compilationCache: new CompilationCache(), cwd: root }
      });

      expect(result.result[1]).toContain('"blue"');
      expect(result.result[1]).not.toContain('"red"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors custom parsers even when the helper prepass has already parsed the source", async () => {
    const parserOverride = vi.fn((code: string) =>
      parseSync(code.replace('"red"', '"blue"'), {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["jsx", "typescript"] }
      })
    );

    const transformed = await babelTransformSource({
      filename,
      source:
        'import { css } from "@mincho-js/css"; export const cls = css({ color: "red" });',
      babel: {
        compilationCache: new CompilationCache(),
        plugins: [() => ({ parserOverride })]
      }
    });

    expect(parserOverride).toHaveBeenCalled();
    expect(transformed.result[1]).toContain('"blue"');
    expect(transformed.result[1]).not.toContain('"red"');
  });

  it("forwards extractCalls separately from Babel core options and respects effective JSX loaders", async () => {
    const transformed = await babelTransformSource({
      filename: "/virtual/entry.js",
      loader: "jsx",
      source:
        'import { make } from "custom-styles"; export const value = make({ color: "red" }); export const App = () => <div />;',
      babel: { extractCalls: { "custom-styles": ["make"] } }
    });

    expect(transformed.code).not.toContain("make({");
    expect(transformed.result[1]).toContain("make({");
  });

  it.each([false, true])(
    "preserves configured Flow syntax before extractCalls with cached parsing=%s",
    async (cached) => {
      const transformed = await babelTransformSource({
        filename: "/virtual/entry.jsx",
        source: `
          import { make } from "custom-styles";
          export type Props = {| color: string |};
          export const value = make({ color: "red" });
          export const App = (props: Props) => <div>{props.color}</div>;
        `,
        babel: {
          compilationCache: cached ? new CompilationCache() : undefined,
          extractCalls: { "custom-styles": ["make"] },
          parserOpts: { plugins: ["flow"] }
        }
      });

      expect(transformed.code).toContain("export type Props = {|");
      expect(transformed.code).toContain("<div>{props.color}</div>");
      expect(transformed.code).not.toContain("make({");
      expect(transformed.result[1]).toContain('color: "red"');
    }
  );

  it.each([false, true])(
    "preserves custom parser plugins before extractCalls with cached parsing=%s",
    async (cached) => {
      const transformed = await babelTransformSource({
        filename,
        source: `
          import { make as css } from "custom-styles";
          export @sealed class View {
            render(): unknown { return <div />; }
          }
          export const value = css({ color: "red" });
        `,
        babel: {
          compilationCache: cached ? new CompilationCache() : undefined,
          extractCalls: { "custom-styles": ["make"] },
          parserOpts: {
            plugins: [["decorators", { decoratorsBeforeExport: false }]]
          }
        }
      });

      expect(transformed.code).toContain("@sealed");
      expect(transformed.code).toContain("<div />");
      expect(transformed.code).not.toContain("css({");
      expect(transformed.result[1]).toContain('color: "red"');
    }
  );

  it.each([false, true])(
    "forwards configured parser plugins to registered extraction dependencies with cached parsing=%s",
    async (cached) => {
      const transformed = await babelTransformSource({
        filename,
        root: "/virtual",
        source: `
          import { make } from "./factory.tsx";
          export const cls = make({ color: "red" });
        `,
        babel: {
          compilationCache: cached ? new CompilationCache() : undefined,
          extractCalls: { "./factory.tsx": ["make"] },
          optimize: { pureFunctions: false },
          parserOpts: {
            plugins: [["decorators", { decoratorsBeforeExport: false }]]
          },
          staticCssEvalSourceProvider: {
            resolve: (_importer, specifier) =>
              specifier === "./factory.tsx"
                ? { id: "/virtual/factory.tsx" }
                : null,
            load: (id) =>
              id === "/virtual/factory.tsx"
                ? {
                    source: `
                      export @sealed class Factory {
                        render(): unknown { return <div />; }
                      }
                      export const make = (rule) => rule;
                    `
                  }
                : null
          }
        }
      });

      expect(transformed.code).not.toContain("make({");
      expect(transformed.result[1]).toContain("make({");
      expect(transformed.result[1]).toContain('color: "red"');
      expect(transformed.staticCssEval?.dependencyFiles).toContain(
        "/virtual/factory.tsx"
      );
    }
  );

  it.each([false, true])(
    "forwards configured parser plugins to pure helper dependencies with cached parsing=%s",
    async (cached) => {
      const transformed = await babelTransformSource({
        filename,
        source: `
          import { css } from "@mincho-js/css";
          import { style } from "/virtual/helper.tsx";
          export @sealed class View { render() { return <div />; } }
          export const cls = css(style(2));
        `,
        babel: {
          compilationCache: cached ? new CompilationCache() : undefined,
          parserOpts: {
            plugins: [["decorators", { decoratorsBeforeExport: false }]]
          },
          staticCssEvalSourceProvider: {
            resolve: (_importer, specifier) =>
              specifier === "/virtual/helper.tsx" ? { id: specifier } : null,
            load: (id) =>
              id === "/virtual/helper.tsx"
                ? {
                    source: `
                      export @sealed class Helper {
                        render(): unknown { return <div />; }
                      }
                      export const style = (n: number) => ({ padding: n * 4 });
                    `
                  }
                : null
          }
        }
      });

      expect(transformed.result[1]).toContain("padding: 8");
      expect(transformed.result[1]).not.toContain("style(2)");
      expect(transformed.code).toContain("@sealed");
      expect(transformed.code).toContain("<div />");
    }
  );

  it("matches owner bindings from the separately parsed extraction prepass", async () => {
    const source = `
      import { style } from "@vanilla-extract/css";
      const make = (rule) => style(rule);
      export { make as registered };
      export const primary = make({ color: "red" });
      export const shadowed = (make) => make({ color: "blue" });
    `;
    const load = vi.fn(() => null);
    const transformed = await babelTransformSource({
      filename: "/virtual/factory.ts",
      root: "/virtual",
      source,
      babel: {
        extractCalls: { "./factory.ts": ["registered"] },
        staticCssEvalSourceProvider: {
          resolve: (_importer, specifier) =>
            specifier === "./factory.ts" ? { id: "/virtual/factory.ts" } : null,
          load
        }
      }
    });

    expect(load).not.toHaveBeenCalled();
    expect(transformed.result[1]).toContain('color: "red"');
    expect(transformed.result[1]).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain('color: "blue"');
    expect(transformed.code).not.toContain('color: "red"');
    expect(transformed.code).toContain("style(rule)");
    expect(transformed.code).toContain('color: "blue"');
  });

  it("uses bundler identities and load keys for local factories and tracks their dependencies", async () => {
    const engine = new MinchoProjectEngine();
    const files: Record<string, string> = {
      "/virtual/factory.ts": 'export { make } from "@helper";',
      "/virtual/helper.ts":
        'import { style } from "@vanilla-extract/css"; export const make = (rule) => style(rule);'
    };

    const provider = {
      resolve: vi.fn((_importer: string, specifier: string) => {
        const file =
          specifier === "./factory.ts" || specifier === "@styles"
            ? "/virtual/factory.ts"
            : specifier === "@helper"
              ? "/virtual/helper.ts"
              : null;

        return file
          ? {
              resolvedFile: file,
              normalizedPathKey: `load:${file}`,
              watchFiles: ["/virtual/aliases.json"]
            }
          : null;
      }),
      load: vi.fn((key: string) => ({
        sourceText: files[key.replace(/^load:/, "")],
        watchFiles: ["/virtual/templates.json"]
      }))
    };

    const babel = {
      extractCalls: { "./factory.ts": ["make"] },
      staticCssEvalSourceProvider: provider,
      staticCssEvalProjectEngine: engine
    };

    const helper = await babelTransformSource({
      filename: "/virtual/helper.ts",
      root: "/virtual",
      source: files["/virtual/helper.ts"]!,
      babel
    });

    expect(helper.code).toContain("style(rule)");
    expect(helper.result[1]).toBe("");

    const transformed = await babelTransformSource({
      filename: "/virtual/entry.ts",
      root: "/virtual",
      source:
        'import { make } from "@styles"; export const value = make({ color: "red" });',
      babel
    });

    expect(transformed.result[1]).toContain("make({");
    expect(transformed.staticCssEval?.dependencyFiles).toEqual(
      expect.arrayContaining([
        "/virtual/factory.ts",
        "/virtual/helper.ts",
        "/virtual/aliases.json",
        "/virtual/templates.json"
      ])
    );
    expect(provider.load).toHaveBeenCalledWith("load:/virtual/factory.ts");
    expect(engine.invalidateByDependency("/virtual/helper.ts")).toContain(
      "/virtual/entry.ts"
    );
  });

  it("keeps recovery dependencies when a registered implementation fails analysis", async () => {
    await expect(
      babelTransformSource({
        filename: "/virtual/entry.ts",
        root: "/virtual",
        source: "export const value = 1;",
        babel: {
          extractCalls: { "./factory.ts": ["make"] },
          staticCssEvalSourceProvider: {
            resolve: () => ({
              id: "/virtual/factory.ts",
              watchFiles: ["/virtual/aliases.json"]
            }),

            load: () => ({ sourceText: "export const make = 1;" })
          }
        }
      })
    ).rejects.toMatchObject({
      name: "BabelTransformError",
      message: expect.stringMatching(/extractCalls.*make.*implementation/),
      staticCssEval: {
        dependencyFiles: expect.arrayContaining([
          "/virtual/factory.ts",
          "/virtual/aliases.json"
        ])
      }
    });
  });

  it("uses the supplied owner source for both the prepass and transformation", async () => {
    const load = vi.fn(() => {
      throw new Error("The owner must not be reloaded");
    });

    const transformed = await babelTransformSource({
      filename,
      source,
      sourceMaps: true,
      babel: {
        jsxCssProp: true,
        staticCssEvalSourceProvider: { resolve: () => null, load }
      }
    });

    expect(load).not.toHaveBeenCalled();
    expect(transformed.code).toContain('marker = "incoming"');
    expect(transformed.result[1]).toContain('"red"');
    expect(transformed.map?.sourcesContent).toEqual([source]);
    expect(transformed.map?.mappings).toBeTruthy();
  });

  it.each([
    ["entry.jsx", "jsx", '<div css={{ color: "red" }} />'],
    ["entry.js", "jsx", '<div css={{ color: "red" }} />'],
    ["entry.js", "tsx", 'const color: string = "red"; <div css={{ color }} />']
  ] as const)(
    "parses %s with its effective %s loader",
    async (name, loader, input) => {
      const transformed = await babelTransformSource({
        filename: `/virtual/${name}`,
        source: input,
        loader,
        babel: { jsxCssProp: true }
      });

      expect(transformed.jsxCssPropTransformed).toBe(true);
      expect(transformed.map).toBeUndefined();
      expect(transformed.code).not.toContain(": string");
    }
  );

  it.each(["resolve", "load"] as const)(
    "clears old engine artifacts when the prepass %s fails",
    async (failure) => {
      const engine = new MinchoProjectEngine();
      seedArtifacts(engine);

      await expect(
        babelTransformSource({
          filename,
          source: 'import { style } from "./tokens"; <div css={style} />;',
          babel: {
            jsxCssProp: true,
            staticCssEvalProjectEngine: engine,
            staticCssEvalSourceProvider: {
              resolve() {
                if (failure === "resolve") throw new Error("resolve failed");

                return { id: "/virtual/tokens.ts" };
              },

              load() {
                throw new Error("load failed");
              }
            }
          }
        })
      ).rejects.toMatchObject({
        name: "BabelTransformError",
        file: filename,
        message: `${failure} failed`
      });

      expect(engine.getFileResult(filename)?.generatedArtifacts).toEqual([]);
      expect(engine.getFileResult(filename)?.dependencyFiles).not.toContain(
        "/stale.ts"
      );
    }
  );

  it("clears old engine artifacts when the file wrapper cannot read its owner", async () => {
    const engine = new MinchoProjectEngine();
    seedArtifacts(engine);

    await expect(
      babelTransform(filename, { staticCssEvalProjectEngine: engine })
    ).rejects.toBeInstanceOf(BabelTransformError);

    expect(engine.getFileResult(filename)?.generatedArtifacts).toEqual([]);
  });
});
