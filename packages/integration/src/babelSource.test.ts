import { describe, expect, it, onTestFinished as afterTest, vi } from "vitest";
import { parseSync, types as t, type PluginObj } from "@babel/core";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { SourceMap } from "node:module";
import { type Loader, transformSync as transformJsx } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
    [false, "coercion", false],
    [false, "coercion", true],
    [true, "coercion", false],
    [true, "coercion", true],
    [false, "tag", false],
    [false, "tag", true],
    [false, "iteration", false],
    [false, "iteration", true],
    [true, "tag", false],
    [true, "tag", true],
    [true, "iteration", false],
    [true, "iteration", true]
  ] as const)(
    "preserves initialization before consumed CommonJS (staged=%s, operation=%s, used=%s)",
    async (staged, operation, used) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-native-cjs-coercion-"));
      afterTest(() => rm(root, { recursive: true, force: true }));
      const filename = join(root, "entry.cjs");
      const consumption =
        operation === "coercion"
          ? 'exports.observed = "" + operand;'
          : operation === "tag"
            ? "exports.observed = operand`check`;"
            : "let item; for (const value of operand) item = value; exports.observed = item;";
      const source = `
        const operand = require("./operand.cjs");
        const {css} = require("@mincho-js/css");
        exports.className = css({color: "red"});
        ${used ? consumption : 'exports.observed = "untouched";'}
      `;
      const read = `
        globalThis.trace.push(${JSON.stringify(operation === "coercion" ? "coerce" : operation)});
        const initialized = globalThis.trace.includes("css-package");
        require("@mincho-js/css");
        return initialized;
      `;
      const operand =
        operation === "coercion"
          ? `{ [Symbol.toPrimitive]() { ${read} } }`
          : operation === "tag"
            ? `function () { ${read} }`
            : `{ *[Symbol.iterator]() { yield (() => { ${read} })(); } }`;
      await Promise.all([
        writeFile(
          join(root, "package.json"),
          JSON.stringify({
            name: "@mincho-js/css",
            type: "commonjs",
            exports: "./css.cjs"
          })
        ),
        writeFile(
          join(root, "css.cjs"),
          'globalThis.trace.push("css-package"); exports.css = style => "class-" + style.color;'
        ),
        writeFile(
          join(root, "operand.cjs"),
          `globalThis.trace.push("load"); module.exports = ${operand};`
        ),
        writeFile(join(root, "native.cjs"), source),
        writeFile(filename, source)
      ]);
      const result = await babelTransformSource({
        root,
        filename,
        source,
        commonJsToEsm: staged,
        babel: {
          configFile: false,
          babelrc: false,
          optimize: { runtimeCodegen: false },
          ...(staged
            ? {
                staticCssEvalSourceProvider: {
                  resolve: (_owner, specifier) => {
                    const id =
                      specifier === "@mincho-js/css"
                        ? join(root, "css.cjs")
                        : specifier === "./operand.cjs"
                          ? join(root, "operand.cjs")
                          : null;
                    return id ? { id, resolvedFile: id } : null;
                  },
                  load: async (id) => ({ source: await readFile(id, "utf8") })
                }
              }
            : {})
        }
      });
      expect(result.result[1]).toMatch(/color:\s*["']red["']/);
      const sidecarExports = [
        ...result.result[1].matchAll(/export\s+var\s+([\w$]+)/g)
      ];
      expect(sidecarExports).toHaveLength(1);
      await writeFile(
        join(root, "sidecar.cjs"),
        `exports.${sidecarExports[0]![1]} = "class-red";`
      );
      const emitted = result.code.replace(result.result[0], "./sidecar.cjs");
      await writeFile(
        filename,
        staged
          ? transformJsx(emitted, { format: "cjs", target: "esnext" }).code
          : emitted
      );
      const run = (file: string) =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              "-e",
              `globalThis.trace = [];const result = require(${JSON.stringify(file)});console.log(JSON.stringify({trace, className:result.className, observed:result.observed}));`
            ],
            {
              cwd: root,
              encoding: "utf8",
              env: { ...process.env, NODE_OPTIONS: "" }
            }
          )
        ) as { trace: string[]; className: string; observed: string | boolean };
      const actual = run("./entry.cjs");
      const original = run("./native.cjs");
      expect(actual).toEqual(
        used
          ? {
              trace: [
                "load",
                "css-package",
                operation === "coercion" ? "coerce" : operation
              ],
              className: "class-red",
              observed: operation === "coercion" ? "true" : true
            }
          : { trace: ["load"], className: "class-red", observed: "untouched" }
      );
      if (used) expect(actual).toEqual(original);
      else expect(original.trace).toEqual(["load", "css-package"]);
    }
  );

  it.each(["cts", "cjs"] as const)(
    "keeps the owner Flow parser separate from an ordinary %s dependency",
    async (extension) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-flow-owner-"));
      afterTest(() => rm(root, { recursive: true, force: true }));
      const filename = join(root, "entry.js");
      const requested = `./dep.${extension}`;
      const dependency = join(root, `dep.${extension}`);
      const loader: Loader = extension === "cts" ? "ts" : "js";
      const source =
        extension === "cts"
          ? "export = { value: 4 };"
          : "module.exports = { value: 4 };";
      await writeFile(dependency, source);
      const pre = vi.fn();
      const result = await babelTransformSource({
        root,
        filename,
        source: `const dep = require(${JSON.stringify(requested)});
          const value: number = dep.value;
          exports.answer = value + 1;`,
        commonJsToEsm: true,
        babel: {
          configFile: false,
          babelrc: false,
          plugins: [
            (): PluginObj => ({
              manipulateOptions(_options, parser) {
                parser.plugins.push("flow");
              },
              pre,
              visitor: {
                Identifier(path) {
                  if (path.node.typeAnnotation?.type === "TypeAnnotation")
                    path.node.typeAnnotation = null;
                }
              }
            })
          ]
        }
      });
      const child = { exports: {} };
      const compiled = transformJsx(source, { format: "cjs", loader }).code;
      new Function("module", "exports", compiled)(child, child.exports);
      const owner = { exports: {} };
      const exportCode = transformJsx(result.code, { format: "cjs" }).code;
      new Function("require", "module", "exports", exportCode)(
        (id: string) => {
          expect([requested, dependency]).toContain(id);
          return child.exports;
        },
        owner,
        owner.exports
      );
      expect(result.commonJsTransformed).toBe(true);
      expect(owner.exports).toMatchObject({ answer: 5 });
      expect(pre).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["js", "flow", "ts"] as const)(
    "normalizes ordinary CommonJS to ESM with the configured %s syntax",
    async (dialect) => {
      const { code } = await babelTransformSource({
        filename:
          dialect === "ts" ? "/virtual/palette.cts" : "/virtual/palette.js",
        source: `${dialect === "flow" ? "type Color = string;" : ""}
          const color${dialect === "ts" ? ": string" : ""} = "red";
          module.exports = { color };`,
        commonJsToEsm: true,
        babel: {
          configFile: false,
          babelrc: false,
          plugins:
            dialect === "flow"
              ? [
                  (): PluginObj => ({
                    manipulateOptions(_options, parser) {
                      parser.plugins.push("flow");
                    },
                    visitor: {
                      TypeAlias(path) {
                        path.remove();
                      }
                    }
                  })
                ]
              : []
        }
      });
      const module = await import(
        `data:text/javascript,${encodeURIComponent(code)}`
      );
      expect(module.default).toEqual({ color: "red" });
      expect(module.color).toBe("red");
    }
  );

  it.each([false, true])(
    "retains preset-enabled authoring dependencies in runtime receipts with owner syntax=%s",
    async (ownerUsesFlow) => {
      const runtimeSource =
        "export const alias = { css: () => 'independent' };";
      const sources: Record<string, string> = {
        "/virtual/factory.js": "export const system = { css: () => 'red' };",
        "/virtual/helper.js": `
          import "./erased.js";
          type Palette = {| color: string |};
          export const alias = { css: () => 'independent' };
        `,
        "/virtual/erased.js": "type Color = 'red'; export {};"
      };
      const transformed = await babelTransformSource({
        filename: "/virtual/entry.js",
        root: "/virtual",
        source: `
          ${ownerUsesFlow ? "type Color = 'red';" : ""}
          import { system } from './factory.js';
          import { alias } from './helper.js';
          alias.css = () => 'blue';
          export const color = system.css();
        `,
        babel: {
          babelrc: false,
          configFile: false,
          presets: [
            () => ({
              plugins: [
                (): PluginObj => ({
                  manipulateOptions(_options, parser) {
                    parser.plugins.push("flow");
                  },
                  visitor: {
                    TypeAlias(path) {
                      path.remove();
                    }
                  }
                })
              ]
            })
          ],
          optimize: { pureFunctions: false },
          extractCalls: { "./factory.js": ["system.css"] },
          staticCssEvalSourceProvider: {
            resolve: (_importer, specifier) => ({
              id: specifier.replace("./", "/virtual/")
            }),
            load: (id) =>
              sources[id] === undefined ? null : { source: sources[id] }
          },
          consumerRuntimeSource: (id) =>
            id === "/virtual/helper.js"
              ? {
                  source: runtimeSource,
                  sourceHash: createHash("sha256")
                    .update(runtimeSource)
                    .digest("hex"),
                  version: "host-v1",
                  watchFiles: [id]
                }
              : undefined
        }
      });

      expect(transformed.result[1]).toContain("system.css");
      expect(transformed.code).not.toContain("system.css");
      expect(transformed.staticCssEval?.dependencyFiles).toContain(
        "/virtual/erased.js"
      );
    }
  );

  it.each([
    ["tokens:theme", "/virtual/tokens.ts"],
    ["/virtual/tokens.ts?variant=dark", "/virtual/tokens.data"]
  ])(
    "selects TypeScript syntax for provider graph ID %s and resolved file %s",
    async (id, resolvedFile) => {
      const transformed = await babelTransformSource({
        filename: "/virtual/entry.jsx",
        root: "/virtual",
        source:
          'import { rule } from "./tokens"; export const App = () => <div css={rule} />;',
        babel: {
          babelrc: false,
          configFile: false,
          optimize: { pureFunctions: false },
          jsxCssProp: { importSource: "custom-styles" },
          staticCssEvalSourceProvider: {
            resolve: (_importer, specifier) =>
              specifier === "./tokens"
                ? {
                    resolvedFile,
                    normalizedPathKey: id
                  }
                : null,
            load: (loadId) =>
              loadId === id
                ? {
                    source:
                      'export const rule: { color: string } = { color: "tomato" };'
                  }
                : null
          }
        }
      });
      expect(transformed.result[1]).toContain('color: "tomato"');
      expect(transformed.staticCssEval?.dependencyFiles).toContain(
        resolvedFile
      );
    }
  );

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
      expect(transformed.parserPlugins).toContain("flow");
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

  it.each([
    ["inferred no-op", undefined, false],
    ["inferred import", undefined, true],
    ["explicit script import", "script", true]
  ] as const)(
    "extracts CSS after a configured pre hook with %s",
    async (_name, sourceType, insert) => {
      const loader: Loader = "jsx";
      const pre = vi.fn((program: t.Program) => {
        if (insert)
          program.body.unshift(
            t.importDeclaration([], t.stringLiteral("./empty.js"))
          );
      });
      const transformed = await babelTransformSource({
        filename: "/virtual/component.jsx",
        root: "/virtual",
        source:
          'const styles = require("./theme.cjs"); module.exports = () => <div css={styles.button} />;',
        commonJsToEsm: true,
        babel: {
          ...(sourceType === undefined ? {} : { sourceType }),
          jsxCssProp: true,
          configFile: false,
          babelrc: false,
          plugins: [
            (): PluginObj => ({
              pre(file) {
                pre(file.ast.program);
              },
              visitor: {}
            })
          ],
          staticCssEvalSourceProvider: {
            resolve: (_owner, source) =>
              source.startsWith("./")
                ? { id: `/virtual/${source.slice(2)}` }
                : null,
            load: (id) => ({
              source: id.endsWith("theme.cjs")
                ? 'exports.button = { color: "red" };'
                : "export {};"
            })
          }
        }
      });
      expect(pre).toHaveBeenCalledOnce();
      const execute = (code: string, mods: Record<string, unknown>) => {
        const module = { exports: {} as Record<string, unknown> };
        const compiled = transformJsx(code, {
          loader,
          jsxFactory: "jsx",
          format: "cjs"
        }).code;
        new Function("require", "module", "exports", "jsx", compiled)(
          (id: string) => {
            if (!Object.hasOwn(mods, id))
              throw new Error(`Unexpected import: ${id}`);
            return mods[id];
          },
          module,
          module.exports,
          (tag: string, props: unknown) => ({ tag, props })
        );
        return module.exports;
      };
      const css = vi.fn(({ color }: { color: string }) => `class-${color}`);
      const sidecar = execute(transformed.result[1], {
        "@mincho-js/css": { css }
      });
      expect(css.mock.calls).toEqual([[{ color: "red" }]]);
      const app = execute(transformed.code, {
        [transformed.result[0]]: sidecar,
        "/virtual/theme.cjs": { button: { color: "red" } },
        "./empty.js": {}
      }).default as () => { props: { className: string } };
      expect(app().props.className).toBe("class-red");
      expect(transformed.code.includes('"./empty.js"')).toBe(insert);
    }
  );

  it("keeps TypeScript import syntax visible to a configured Babel pre hook", async () => {
    const seen: string[] = [];
    const transformed = await babelTransformSource({
      filename: "/virtual/entry.tsx",
      root: "/virtual",
      source: `import data = require("./original");
        export const value = data.value;
        export const Box = () => <div css={{ color: "red" }} />;`,
      babel: {
        babelrc: false,
        configFile: false,
        plugins: [
          (): PluginObj => ({
            visitor: {},
            pre(file) {
              for (const statement of file.ast.program.body)
                if (
                  t.isTSImportEqualsDeclaration(statement) &&
                  t.isTSExternalModuleReference(statement.moduleReference) &&
                  t.isStringLiteral(statement.moduleReference.expression)
                ) {
                  seen.push(statement.moduleReference.expression.value);
                  statement.moduleReference.expression =
                    t.stringLiteral("./generated");
                }
            }
          })
        ],
        optimize: { pureFunctions: false },
        jsxCssProp: true,
        staticCssEvalSourceProvider: {
          resolve: () => null,
          load: () => null
        }
      }
    });
    expect(seen).toEqual(["./original"]);
    expect(transformed.code).toContain("./generated");
    expect(transformed.code).not.toContain("./original");
    expect(transformed.result[1]).toContain('color: "red"');
  });

  it.each([false, true])(
    "does not apply a fold from an ESM import changed by a configured pre hook: %s",
    async (redirect) => {
      const transformed = await babelTransformSource({
        filename: "/virtual/entry.jsx",
        root: "/virtual",
        source: `type Options = {| padding: number |};
          import { size } from "./theme.js";
          export const value = size();
          export const Box = () => <div css={{ padding: size() }} />;`,
        babel: {
          configFile: false,
          babelrc: false,
          plugins: [
            (): PluginObj => ({
              manipulateOptions(_options, parser) {
                parser.plugins.push("flow");
              },
              pre(file) {
                if (!redirect) return;
                for (const statement of file.ast.program.body)
                  if (
                    t.isImportDeclaration(statement) &&
                    statement.source.value === "./theme.js"
                  )
                    statement.source = t.stringLiteral("./other.js");
              },
              visitor: {
                TypeAlias(path) {
                  path.remove();
                }
              }
            })
          ],
          jsxCssProp: true,
          staticCssEvalSourceProvider: {
            resolve: (_importer, specifier) => ({
              id: specifier.replace("./", "/virtual/")
            }),
            load: (id) => ({
              source: `type Options = {| n: number |}; export function size(): number { return ${id.endsWith("/other.js") ? 8 : 4}; }`
            })
          }
        }
      });
      expect(transformed.code).toContain(
        redirect ? "./other.js" : "./theme.js"
      );
      expect(transformed.result[1]).toContain(
        redirect ? 'from "./other.js"' : "padding: 4"
      );
      if (redirect) {
        expect(transformed.result[1]).toContain("padding: size()");
        expect(transformed.result[1]).not.toContain("padding: 4");
      }
    }
  );

  it.each([
    "unchanged",
    "require-redirect",
    "palette-redirect",
    "esm-palette-redirect",
    "registration-edit",
    "both",
    "added-edge",
    "added-effect",
    "added-edge-and-require",
    "added-edge-and-registration"
  ] as const)(
    "uses the final Babel Program for independent CommonJS and ESM style work: %s",
    async (mode) => {
      const pre = vi.fn();
      const transformed = await babelTransformSource({
        filename: "/virtual/component.jsx",
        root: "/virtual",
        source: `
          import { make } from "./factory.js";
          ${mode === "esm-palette-redirect" ? 'import { styles } from "./red.mjs";' : 'const styles = require("./red.cjs");'}
          export function readFlag() { return require("./flags-a.cjs").enabled; }
          export const chip = make({ color: "green" });
          export const Box = () => <div css={styles.button} />;`,
        babel: {
          jsxCssProp: true,
          configFile: false,
          babelrc: false,
          extractCalls: { "./factory.js": ["make"] },
          plugins: [
            (): PluginObj => ({
              pre(file) {
                pre();
                const [factory, palette] = file.ast.program.body;
                if (
                  t.isImportDeclaration(factory) &&
                  (mode === "registration-edit" ||
                    mode === "both" ||
                    mode === "added-edge-and-registration")
                )
                  factory.source = t.stringLiteral("./other.js");
                if (
                  mode === "esm-palette-redirect" &&
                  t.isImportDeclaration(palette)
                )
                  palette.source = t.stringLiteral("./blue.mjs");
                if (
                  mode === "palette-redirect" &&
                  t.isVariableDeclaration(palette)
                ) {
                  const call = palette.declarations[0]?.init;
                  if (t.isCallExpression(call))
                    call.arguments = [t.stringLiteral("./blue.cjs")];
                }
                if (
                  mode === "require-redirect" ||
                  mode === "both" ||
                  mode === "added-edge-and-require"
                )
                  file.path.traverse({
                    CallExpression(path) {
                      const [input] = path.node.arguments;
                      if (
                        path.get("callee").isIdentifier({ name: "require" }) &&
                        t.isStringLiteral(input, { value: "./flags-a.cjs" })
                      )
                        path.node.arguments = [
                          t.stringLiteral("./flags-b.cjs")
                        ];
                    }
                  });
                if (mode.startsWith("added-")) {
                  file.ast.program.body.unshift(
                    t.importDeclaration(
                      [],
                      t.stringLiteral(
                        mode === "added-effect" ? "./observe.js" : "./empty.js"
                      )
                    ),
                    t.importDeclaration([], t.stringLiteral("./after.js"))
                  );
                }
              },
              visitor: {}
            })
          ],
          staticCssEvalSourceProvider: {
            resolve: (_importer, specifier) =>
              specifier.startsWith("./")
                ? {
                    id: specifier.replace(".", "/virtual")
                  }
                : null,
            load: (id) => ({
              source: id.endsWith("factory.js")
                ? 'import { style } from "@vanilla-extract/css"; export const make = (rule) => style(rule);'
                : id.endsWith("other.js")
                  ? 'export const make = () => "runtime";'
                  : id.includes("flags-")
                    ? "exports.enabled = true;"
                    : id.endsWith("empty.js") || id.endsWith("after.js")
                      ? "export {};"
                      : id.endsWith("observe.js")
                        ? "console.log('observe');"
                        : id.endsWith("blue.mjs")
                          ? 'export const styles = { button: { color: "blue" } };'
                          : id.endsWith("red.mjs")
                            ? 'export const styles = { button: { color: "red" } };'
                            : id.endsWith("blue.cjs")
                              ? 'exports.button = { color: "blue" };'
                              : 'exports.button = { color: "red" };'
            })
          }
        }
      });
      expect(pre).toHaveBeenCalledTimes(1);
      const moved =
        mode !== "registration-edit" &&
        mode !== "both" &&
        mode !== "added-edge-and-registration";
      if (moved) {
        expect(transformed.result[1]).toContain('color: "green"');
        expect(transformed.result[1]).toContain("make({");
        expect(transformed.result[1]).toContain(
          mode.endsWith("palette-redirect") ? 'color: "blue"' : 'color: "red"'
        );
        if (mode.endsWith("palette-redirect")) {
          expect(transformed.result[1]).not.toContain('color: "red"');
          const extension = mode === "esm-palette-redirect" ? "mjs" : "cjs";
          expect(transformed.staticCssEval?.dependencyFiles).toEqual(
            expect.arrayContaining([
              `/virtual/red.${extension}`,
              `/virtual/blue.${extension}`
            ])
          );
        }
        expect(transformed.code).toContain(transformed.result[0]);
        expect(transformed.code).not.toContain("make({");
      } else {
        expect(transformed.result[1]).not.toContain('color: "green"');
        expect(transformed.code).toContain('from "./other.js"');
        expect(transformed.code).toContain("make({");
      }
      if (mode.startsWith("added-")) {
        const first = mode === "added-effect" ? "./observe.js" : "./empty.js";
        expect(transformed.code).toContain(first);
        expect(transformed.code.indexOf(first)).toBeLessThan(
          transformed.code.indexOf("./after.js")
        );
      }
      expect(transformed.code).toContain(
        mode === "require-redirect" ||
          mode === "both" ||
          mode === "added-edge-and-require"
          ? "./flags-b.cjs"
          : "./flags-a.cjs"
      );
    }
  );

  it.each(
    (["esm", "cjs"] as const).flatMap((form) =>
      [
        { edit: "", erasedDeclaration: true },
        {
          edit: 'import type { Color } from "./types.ts";',
          erasedDeclaration: true
        },
        {
          edit: 'export type { Color } from "./types.ts";',
          erasedDeclaration: true
        },
        { edit: 'export type * from "./types.ts";', erasedDeclaration: true },
        {
          edit: 'import type Types = require("./types.ts");',
          erasedDeclaration: true
        },
        { edit: 'import "./observe.js";', erasedDeclaration: false },
        {
          edit: 'import { type Color } from "./types.ts";',
          erasedDeclaration: false
        }
      ].map((row) => ({ form, ...row }))
    )
  )(
    "treats pre-hook declaration $edit with fresh style facts while preserving runtime edges ($form)",
    async ({ form, edit, erasedDeclaration }) => {
      const pre = vi.fn();
      const resolve = vi.fn((_importer: string, specifier: string) => ({
        id: specifier.replace(".", "/virtual")
      }));
      const transformed = await babelTransformSource({
        filename: "/virtual/component.tsx",
        root: "/virtual",
        source: `${form === "esm" ? 'import { styles } from "./theme.ts";' : 'const styles = require("./theme.cjs");'}
          export const Box = () => <div css={styles.button} />;`,
        babel: {
          jsxCssProp: true,
          configFile: false,
          babelrc: false,
          plugins: [
            (): PluginObj => ({
              pre(file) {
                pre();
                if (!edit) return;
                const declaration = parseSync(edit, {
                  configFile: false,
                  babelrc: false,
                  parserOpts: { plugins: ["typescript"] }
                })!.program.body[0]!;
                file.ast.program.body.unshift(declaration);
              },
              visitor: {}
            })
          ],
          staticCssEvalSourceProvider: {
            resolve,
            load: (id) => ({
              source: id.endsWith("theme.ts")
                ? 'export const styles = { button: { color: "red" } };'
                : id.endsWith("theme.cjs")
                  ? 'exports.button = { color: "red" };'
                  : id.endsWith("types.ts")
                    ? "export type Color = string;"
                    : ""
            })
          }
        }
      });
      expect(pre).toHaveBeenCalledTimes(1);
      expect(transformed.result[1]).toContain('color: "red"');
      expect(transformed.code).toContain(transformed.result[0]);
      if (erasedDeclaration) {
        expect(transformed.code).not.toContain("./types.ts");
        expect(
          resolve.mock.calls.some(([, specifier]) => specifier === "./types.ts")
        ).toBe(false);
      }
      if (edit.includes("observe.js")) {
        expect(transformed.code).toContain('import "./observe.js"');
        expect(
          resolve.mock.calls.some(
            ([, specifier]) => specifier === "./observe.js"
          )
        ).toBe(true);
      }
    }
  );

  it.each(
    (["import equals", "require"] as const).flatMap((form) =>
      [false, true].flatMap((redirect) =>
        (["registered call", "JSX value"] as const).map((role) => ({
          form,
          redirect,
          role
        }))
      )
    )
  )(
    "uses the selected configured CommonJS module for $role ($form, redirect=$redirect)",
    async ({ form, redirect, role }) => {
      const pre = vi.fn();
      const transformed = await babelTransformSource({
        filename: "/virtual/component.tsx",
        root: "/virtual",
        source: `${form === "import equals" ? 'import preset = require("./red.ts");' : 'const preset = require("./red.ts");'}
          ${role === "registered call" ? 'export const primary = preset.make({ color: "green" });' : "export const App = () => <div css={preset.styleRule} />;"}`,
        babel: {
          jsxCssProp: true,
          configFile: false,
          babelrc: false,
          extractCalls: { "./red.ts": ["make"], "./blue.ts": ["make"] },
          plugins: [
            (): PluginObj => ({
              pre(file) {
                pre();
                if (!redirect) return;
                const first = file.ast.program.body[0];
                const target = t.stringLiteral("./blue.ts");
                if (
                  t.isTSImportEqualsDeclaration(first) &&
                  t.isTSExternalModuleReference(first.moduleReference)
                )
                  first.moduleReference.expression = target;
                else if (t.isVariableDeclaration(first)) {
                  const expression = first.declarations[0]?.init;
                  if (t.isCallExpression(expression))
                    expression.arguments = [target];
                }
              },
              visitor: {}
            })
          ],
          staticCssEvalSourceProvider: {
            resolve: (_importer, specifier) =>
              specifier === "./red.ts" || specifier === "./blue.ts"
                ? { id: specifier.replace(".", "/virtual") }
                : null,
            load: (id) => ({
              source: `import { style } from "@vanilla-extract/css";
                export const make = (rule) => style(rule);
                export const styleRule = { color: "${id.endsWith("blue.ts") ? "blue" : "red"}" };`
            })
          }
        }
      });
      expect(pre).toHaveBeenCalledTimes(1);
      const color = redirect ? "blue" : "red";
      if (role === "registered call") {
        expect(transformed.result[1]).toContain(`./${color}.ts`);
        expect(transformed.result[1]).toContain('color: "green"');
      } else {
        expect(transformed.result[1]).toContain(`color: "${color}"`);
        expect(transformed.result[1]).not.toContain(
          `color: "${redirect ? "red" : "blue"}"`
        );
      }
      expect(transformed.code).toContain(transformed.result[0]);
      expect(transformed.code).not.toContain("preset.make(");
    }
  );

  it.each(
    (["literal", "const"] as const).flatMap((form) =>
      (["unchanged", "plugin", "preset", "both"] as const).map((mode) => ({
        form,
        mode
      }))
    )
  )(
    "uses the effective ordinary CommonJS style import after Babel $mode pre hooks ($form)",
    async ({ form, mode }) => {
      const direct = vi.fn();
      const preset = vi.fn();
      const redirect = (
        program: t.Program,
        replacement: string | undefined,
        record: (specifier: string) => void
      ) => {
        const statement = program.body[0];
        const call = t.isVariableDeclaration(statement)
          ? statement.declarations[0]?.init
          : undefined;
        const input =
          form === "const"
            ? call
            : t.isCallExpression(call)
              ? call.arguments[0]
              : undefined;
        if (!t.isStringLiteral(input))
          throw new Error("missing fixture import");
        record(input.value);
        if (replacement && t.isVariableDeclaration(statement)) {
          if (form === "const")
            statement.declarations[0]!.init = t.stringLiteral(replacement);
          else if (t.isCallExpression(call))
            call.arguments = [t.stringLiteral(replacement)];
        }
      };
      const transformed = await babelTransformSource({
        filename: "/virtual/component.jsx",
        root: "/virtual",
        source: `${form === "const" ? 'const specifier = "./red.cjs"; const styles = require(specifier);' : 'const styles = require("./red.cjs");'}
          export const Box = () => <div css={styles.button} />;`,
        babel: {
          jsxCssProp: true,
          configFile: false,
          babelrc: false,
          ...(mode !== "preset"
            ? {
                plugins: [
                  (): PluginObj => ({
                    pre(file) {
                      redirect(
                        file.ast.program,
                        mode === "unchanged"
                          ? undefined
                          : mode === "both"
                            ? "./intermediate.cjs"
                            : "./blue.cjs",
                        direct
                      );
                    },
                    visitor: {}
                  })
                ]
              }
            : {}),
          ...(mode === "preset" || mode === "both"
            ? {
                presets: [
                  () => ({
                    plugins: [
                      (): PluginObj => ({
                        pre(file) {
                          redirect(file.ast.program, "./blue.cjs", preset);
                        },
                        visitor: {}
                      })
                    ]
                  })
                ]
              }
            : {}),
          staticCssEvalSourceProvider: {
            resolve: (_importer, specifier) => ({
              id: specifier.replace(".", "/virtual")
            }),
            load: (id) => ({
              source: `exports.button = { color: "${id.includes("blue") ? "blue" : "red"}" };`
            })
          }
        }
      });
      const expected = mode === "unchanged" ? "red" : "blue";
      expect(transformed.result[1]).toContain(`color: "${expected}"`);
      if (expected === "blue")
        expect(transformed.result[1]).not.toContain('color: "red"');
      expect(direct.mock.calls).toEqual(
        mode === "preset" ? [] : [["./red.cjs"]]
      );
      expect(preset.mock.calls).toEqual(
        mode === "both"
          ? [["./intermediate.cjs"]]
          : mode === "preset"
            ? [["./red.cjs"]]
            : []
      );
    }
  );

  it.each([
    ["unchanged", true, true],
    ["body", true, true],
    ["initializer", true, true],
    ["body", false, true],
    ["body", true, false]
  ] as const)(
    "uses the current Babel Program for a %s pre hook (provider=%s, clone=%s)",
    async (change, withProvider, cloneInputAst) => {
      const observed = vi.fn();
      const transformed = await babelTransformSource({
        filename: "/virtual/entry.jsx",
        root: "/virtual",
        source: `
          const initial = 4;
          function size() { return initial; }
          export const value = size();
          export const Box = () => <div css={{ padding: size() }} />;`,
        babel: {
          configFile: false,
          babelrc: false,
          cloneInputAst,
          jsxCssProp: true,
          plugins: [
            (): PluginObj => ({
              pre(file) {
                observed();
                for (const statement of file.ast.program.body) {
                  if (
                    change === "body" &&
                    t.isFunctionDeclaration(statement) &&
                    statement.id?.name === "size"
                  )
                    statement.body = t.blockStatement([
                      t.returnStatement(t.numericLiteral(8))
                    ]);
                  if (
                    change === "initializer" &&
                    t.isVariableDeclaration(statement)
                  )
                    for (const declaration of statement.declarations)
                      if (t.isIdentifier(declaration.id, { name: "initial" }))
                        declaration.init = t.numericLiteral(8);
                }
              },
              visitor: {}
            })
          ],
          ...(withProvider
            ? {
                staticCssEvalSourceProvider: {
                  resolve: () => null,
                  load: () => null
                }
              }
            : {})
        }
      });
      expect(observed).toHaveBeenCalledOnce();
      if (change === "unchanged") {
        expect(transformed.result[1]).toContain("padding: 4");
      } else {
        expect(transformed.result[1]).not.toContain("padding: 4");
        expect(transformed.result[1]).toMatch(/padding: (8|size\(\))/);
        if (transformed.result[1].includes("padding: size()"))
          expect(transformed.result[1]).toMatch(/return 8|initial = 8/);
      }
    }
  );

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true]
  ])(
    "normalizes TypeScript import-equals after configured syntax retry cached=%s, tokens=%s",
    async (cached, tokens) => {
      const visitDecorator = vi.fn();
      const observeOriginal = vi.fn();
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
          parserOpts: { tokens },
          presets: [
            () => ({
              plugins: [
                (): PluginObj => ({
                  manipulateOptions(_options, parser) {
                    parser.plugins.push("decorators-legacy");
                  },
                  pre(file) {
                    observeOriginal({
                      tokens: Boolean(file.ast.tokens?.length),
                      importKind: file.ast.program.body[0]?.type
                    });
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
      expect(observeOriginal).toHaveBeenCalledExactlyOnceWith({
        tokens,
        importKind: "TSImportEqualsDeclaration"
      });
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
    "uses preset-enabled syntax for an imported static rule with owner syntax=%s",
    async (ownerUsesFlow) => {
      const visitType = vi.fn();
      const transformed = await babelTransformSource({
        filename: "/virtual/entry.jsx",
        root: "/virtual",
        source: `
          ${ownerUsesFlow ? "type Palette = {| color: string |};" : ""}
          import { rule } from "./styles.js";
          export const App = () => <div css={rule} />;
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
          jsxCssProp: { importSource: "custom-styles" },
          staticCssEvalSourceProvider: {
            resolve: (_importer, specifier) =>
              specifier === "./styles.js" ? { id: "/virtual/styles.js" } : null,
            load: (id) =>
              id === "/virtual/styles.js"
                ? {
                    source: `
                      type Palette = {| color: string |};
                      export const rule: Palette = { color: "tomato" };
                    `
                  }
                : null
          }
        }
      });

      expect(transformed.result[1]).toContain('color: "tomato"');
      expect(transformed.code).not.toContain("css=");
      expect(transformed.code).not.toContain("type Palette");
      expect(visitType).toHaveBeenCalledTimes(ownerUsesFlow ? 1 : 0);
      expect(transformed.staticCssEval?.dependencyFiles).toContain(
        "/virtual/styles.js"
      );
      expect(transformed.staticCssEval?.diagnostics).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: "unsupported-source-shape" })
        ])
      );
    }
  );

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

  it.each([false, true])(
    "matches same-file registered bindings after ordinary pre edge edits (%s)",
    async (addedEdge) => {
      const pre = vi.fn();
      const source = `
      import { style } from "@vanilla-extract/css";
      const make = (rule) => style(rule);
      export { make as registered };
      export const primary = make({ color: "red" });
      export const shadowed = (make) => make({ color: "blue" });
      export const App = () => <div css={{ color: "green" }} />;
    `;
      const load = vi.fn((id: string) =>
        id === "/virtual/empty.js" ? { source: "export {};" } : null
      );
      const transformed = await babelTransformSource({
        filename: "/virtual/factory.tsx",
        root: "/virtual",
        source,
        babel: {
          jsxCssProp: true,
          configFile: false,
          babelrc: false,
          plugins: [
            (): PluginObj => ({
              pre(file) {
                pre();
                if (addedEdge)
                  file.ast.program.body.unshift(
                    t.importDeclaration([], t.stringLiteral("./empty.js"))
                  );
              },
              visitor: {}
            })
          ],
          extractCalls: { "./factory.tsx": ["registered"] },
          staticCssEvalSourceProvider: {
            resolve: (_importer, specifier) =>
              specifier === "./factory.tsx"
                ? { id: "/virtual/factory.tsx" }
                : specifier === "./empty.js"
                  ? { id: "/virtual/empty.js" }
                  : null,
            load
          }
        }
      });

      expect(pre).toHaveBeenCalledTimes(1);
      expect(load.mock.calls.some(([id]) => id === "/virtual/empty.js")).toBe(
        addedEdge
      );
      expect(transformed.code.includes("./empty.js")).toBe(addedEdge);
      expect(transformed.result[1]).toContain('color: "green"');
      expect(transformed.result[1]).toContain('color: "red"');
      expect(transformed.result[1]).toContain("style(rule)");
      expect(transformed.result[1]).not.toContain('color: "blue"');
      expect(transformed.code).not.toContain('color: "red"');
      expect(transformed.code).toContain("style(rule)");
      expect(transformed.code).toContain('color: "blue"');
    }
  );

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

  it.each([
    ["inline", "none"],
    ["explicit", "none"],
    ["inline", "direct"],
    ["explicit", "direct"],
    ["explicit", "overrides"],
    ["explicit", "env"],
    ["inline", "direct", true],
    ["explicit", "overrides", true],
    ["explicit", "direct", true, true],
    ["explicit", "direct", false, true]
  ] as const)(
    "composes an %s upstream map for staged authored CommonJS (configured generator=%s, reader=%s, alias=%s)",
    async (mapKind, mode, generatedReader?: boolean, alias?: true) => {
      const configuredGenerator = mode !== "none";
      const root = "/virtual";
      const entry = `${root}/main.cjs`;
      const target = `${root}/compat.cjs`;
      const child = `${root}/later.cjs`;
      const input =
        (alias
          ? 'const api=require("@mincho-js/css"); const compat=api; const css=compat.css;'
          : 'const {css}=require("@mincho-js/css");') +
        ' const later=require("./later.cjs"); exports.className=css({color:"red"}); /* author marker */ exports.marker="before"; exports.read=()=>later.ok;';
      const authored = "\n".repeat(8) + input;
      const upstream = {
        version: 3 as const,
        file: "main.cjs",
        sources: ["author-view.cjs"],
        sourcesContent: [authored],
        names: [],
        mappings: "AAQA"
      };
      const inlineComment = [
        "//",
        "# sourceMappingURL=data:application/json;base64,",
        Buffer.from(JSON.stringify(upstream)).toString("base64")
      ].join("");
      const contents =
        mapKind === "inline" ? `${input}\n${inlineComment}` : input;
      const pre = vi.fn();
      const post = vi.fn((file: { ast: t.File }) => {
        if (!configuredGenerator) return;
        const marker = file.ast.program.body.find(
          (statement): statement is t.ExpressionStatement =>
            t.isExpressionStatement(statement) &&
            t.isAssignmentExpression(statement.expression) &&
            t.isStringLiteral(statement.expression.right, { value: "before" })
        );
        if (!marker || !t.isAssignmentExpression(marker.expression))
          throw new Error("Expected the authored export in the final visitor");
        marker.expression.right = t.stringLiteral("middle");
      });
      const generatorOverride = vi.fn(
        (
          ast: t.File,
          options: unknown,
          source: string,
          generate: (
            ast: t.File,
            options: unknown,
            source: string
          ) => {
            code: string;
          }
        ) => {
          const generated = generate(ast, options, source);
          expect(generated.code).toContain('"middle"');
          // This is an authored binding until the actual emitted program is
          // available, so the generator can add a normal source-level read.
          if (alias) {
            expect(generated.code).toContain("const compat = api;");
            expect(generated.code).toContain("const css = compat.css;");
          } else {
            expect(generated.code).toMatch(
              /\{\s*css\s*\}\s*=\s*require\("@mincho-js\/css"\)/
            );
          }
          return {
            ...generated,
            code:
              generated.code.replace('"middle"', '"later!"') +
              (generatedReader ? "\nexports.kind = typeof css;" : "")
          };
        }
      );
      const authorPlugin = () => ({
        pre,
        post,
        ...(configuredGenerator ? { generatorOverride } : {}),
        visitor: {}
      });
      const authorConfig =
        mode === "overrides"
          ? { overrides: [{ plugins: [authorPlugin] }] }
          : mode === "env"
            ? {
                envName: "mincho-test",
                env: { "mincho-test": { plugins: [authorPlugin] } }
              }
            : { plugins: [authorPlugin] };
      const transformed = await babelTransformSource({
        filename: entry,
        root,
        source: contents,
        commonJsToEsm: true,
        sourceMaps: true,
        ...(mapKind === "explicit" ? { inputSourceMap: upstream } : {}),
        babel: {
          configFile: false,
          babelrc: false,
          ...authorConfig,
          optimize: { runtimeCodegen: false },
          staticCssEvalSourceProvider: {
            resolve(_owner, specifier) {
              if (specifier === "@mincho-js/css")
                return { id: target, resolvedFile: target };
              if (specifier === "./later.cjs")
                return { id: child, resolvedFile: child };
              return null;
            },
            load(id) {
              if (id === target)
                return { source: "exports.css=(rule)=>rule.color;" };
              if (id === child) return { source: "exports.ok=true;" };
              return null;
            }
          }
        }
      });
      expect(pre).toHaveBeenCalledOnce();
      expect(post).toHaveBeenCalledOnce();
      expect(generatorOverride).toHaveBeenCalledTimes(
        configuredGenerator ? 1 : 0
      );
      expect(transformed.code).toContain(
        configuredGenerator ? '"later!"' : '"before"'
      );
      expect(transformed.code).toContain("author marker");
      expect(transformed.result[1]).toContain('color: "red"');
      if (generatedReader) {
        expect(transformed.code).toContain(target);
        expect(transformed.code).toContain("typeof css");
        if (alias) {
          const compiled = transformJsx(transformed.code, { format: "cjs" });
          const sidecar = { exports: {} as Record<string, unknown> };
          const load = (id: string) => {
            if (id === target || id === "@mincho-js/css")
              return { css: () => "red-class" };
            if (id === child) return { ok: true };
            if (id === transformed.result[0]) return sidecar.exports;
            throw new Error(`Unexpected fixture import ${id}`);
          };
          const evaluate = (code: string, module: typeof sidecar) =>
            new Function("require", "module", "exports", code)(
              load,
              module,
              module.exports
            );
          evaluate(
            transformJsx(transformed.result[1], { format: "cjs" }).code,
            sidecar
          );
          const fixture = { exports: {} as Record<string, unknown> };
          evaluate(compiled.code, fixture);
          expect(fixture.exports).toMatchObject({
            kind: "function",
            className: "red-class"
          });
        }
      } else {
        expect(transformed.code).not.toContain(target);
        expect(transformed.code).not.toContain('require("@mincho-js/css")');
        if (alias) {
          expect(transformed.code).not.toContain("const compat");
          expect(transformed.code).not.toContain("const css");
        }
      }
      const map = transformed.map;
      expect(map?.sources).toEqual(["author-view.cjs"]);
      expect(map?.sourcesContent).toEqual([authored]);
      if (!map) throw new Error("Expected the actual composed source map");
      const offset = transformed.code.indexOf("later.ok");
      expect(offset).toBeGreaterThanOrEqual(0);
      const before = transformed.code.slice(0, offset).split("\n");
      const location = new SourceMap({
        ...map,
        sourcesContent: map.sourcesContent ?? [],
        sourceRoot: map.sourceRoot ?? ""
      }).findEntry(before.length - 1, before.at(-1)!.length);
      expect(location).toMatchObject({
        originalSource: expect.stringContaining("author-view.cjs"),
        originalLine: 8,
        originalColumn: 0
      });
    }
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
    [true, false, true],
    [true, true, true]
  ] as const)(
    "reconciles generator reads of an otherwise dead CSS binding (live cx=%s, generated read=%s, alias=%s)",
    async (shared, read, alias?: true) => {
      const source =
        (alias
          ? 'const api=require("@mincho-js/css"); const css=api.css;'
          : shared
            ? 'const {css,cx}=require("@mincho-js/css");'
            : 'const {css}=require("@mincho-js/css");') +
        'exports.className=css({color:"red"});' +
        (shared
          ? alias
            ? 'exports.combo=api.cx("a","b");'
            : 'exports.combo=cx("a","b");'
          : "");
      const target = "/virtual/css.cjs";
      const generatorOverride = vi.fn(
        (
          ast: t.File,
          options: unknown,
          input: string,
          generate: (
            ast: t.File,
            options: unknown,
            input: string
          ) => { code: string }
        ) => {
          const generated = generate(ast, options, input);
          if (alias) expect(generated.code).toContain("const css = api.css;");
          else
            expect(generated.code).toMatch(
              /\{\s*css(?:\s*,\s*cx)?\s*\}\s*=\s*require/
            );
          return {
            ...generated,
            code: generated.code + (read ? "\nexports.kind=typeof css;" : "")
          };
        }
      );
      const output = await babelTransformSource({
        filename: "/virtual/entry.cjs",
        root: "/virtual",
        commonJsToEsm: true,
        source,
        babel: {
          configFile: false,
          babelrc: false,
          plugins: [() => ({ generatorOverride, visitor: {} })],
          optimize: { runtimeCodegen: false },
          staticCssEvalSourceProvider: {
            resolve(_owner, specifier) {
              return specifier === "@mincho-js/css"
                ? { id: target, resolvedFile: target }
                : null;
            },
            load() {
              return {
                source:
                  'exports.css=rule=>"class-"+rule.color; exports.cx=(...x)=>x.join(" ");'
              };
            }
          }
        }
      });
      expect(generatorOverride).toHaveBeenCalledOnce();
      const css = {
        css: (rule: { color: string }) => "class-" + rule.color,
        cx: (...parts: string[]) => parts.join(" ")
      };
      const execute = (code: string, load: (id: string) => unknown) => {
        const module = { exports: {} };
        new Function(
          "require",
          "module",
          "exports",
          transformJsx(code, { format: "cjs" }).code
        )(load, module, module.exports);
        return module.exports;
      };
      const sidecar = execute(output.result[1], () => css);
      const actual = execute(output.code, (id) => {
        if (id === output.result[0]) return sidecar;
        if (id === target || id === "@mincho-js/css") return css;
        throw new Error("unexpected dependency " + id);
      });
      expect(actual).toMatchObject({
        className: "class-red",
        ...(shared ? { combo: "a b" } : {}),
        ...(read ? { kind: "function" } : {})
      });
      if (!read) expect(output.code).not.toMatch(/\bcss\s*\}/);
      if (alias && !read)
        expect(output.code).not.toContain("const css = api.css;");
      if (!shared && !read) expect(output.code).not.toContain(target);
    }
  );

  it.each([false, true])(
    "prunes a dead CJS alias only while its actual producer is unchanged (replace=%s)",
    async (replace) => {
      const source =
        'const api=require("@mincho-js/css");const css=api.css;exports.cls=css({color:"red"});exports.combo=api.cx("a","b");';
      const target = "/virtual/css.cjs";
      const post = vi.fn((file: { ast: t.File }) => {
        if (!replace) return;
        const replacement = parseSync(
          '({get css(){trace.push("getter");return rule=>"class-"+rule.color;},cx(...items){return items.join(" ");}})',
          { configFile: false, babelrc: false }
        )?.program.body[0];
        if (!t.isExpressionStatement(replacement))
          throw new Error("missing fixture object");
        for (const statement of file.ast.program.body)
          if (t.isVariableDeclaration(statement))
            for (const declaration of statement.declarations)
              if (t.isIdentifier(declaration.id, { name: "api" }))
                declaration.init = replacement.expression;
      });
      const result = await babelTransformSource({
        root: "/virtual",
        filename: "/virtual/entry.cjs",
        source,
        commonJsToEsm: true,
        babel: {
          configFile: false,
          babelrc: false,
          optimize: { runtimeCodegen: false },
          plugins: [() => ({ post, visitor: {} })],
          staticCssEvalSourceProvider: {
            resolve(_owner, specifier) {
              return specifier === "@mincho-js/css"
                ? { id: target, resolvedFile: target }
                : null;
            },
            load() {
              return {
                source:
                  'exports.css=rule=>"class-"+rule.color;exports.cx=(...items)=>items.join(" ");'
              };
            }
          }
        }
      });
      expect(post).toHaveBeenCalledOnce();
      const trace: string[] = [];
      const css = {
        css: (rule: { color: string }) => "class-" + rule.color,
        cx: (...items: string[]) => items.join(" ")
      };
      const execute = (code: string, load: (id: string) => unknown) => {
        const module = { exports: {} };
        new Function(
          "module",
          "exports",
          "require",
          "trace",
          transformJsx(code, { format: "cjs" }).code
        )(module, module.exports, load, trace);
        return module.exports;
      };
      const sidecar = execute(result.result[1], () => css);
      const runtime = execute(result.code, (id) =>
        id === result.result[0] ? sidecar : css
      );
      expect(runtime).toMatchObject({ cls: "class-red", combo: "a b" });
      expect(trace).toEqual(replace ? ["getter"] : []);
      if (!replace) expect(result.code).not.toContain("const css = api.css;");
    }
  );

  it.each([false, true])(
    "reconciles a configured ESM generator's actual import readers (generated reader=%s)",
    async (read) => {
      const source =
        'import {css} from "@mincho-js/css"; export const cls=css({color:"red"}); export const marker="tail";';
      const generate = vi.fn(
        (
          ast: t.File,
          options: unknown,
          input: string,
          run: (
            ast: t.File,
            options: unknown,
            input: string
          ) => { code: string }
        ) => {
          const output = run(ast, options, input);
          expect(output.code).toMatch(/import\s*\{\s*css\s*\}\s*from/);
          return {
            ...output,
            code: output.code + (read ? "\nexport const kind=typeof css;" : "")
          };
        }
      );
      const result = await babelTransformSource({
        root: "/virtual",
        filename: "/virtual/entry.mjs",
        source,
        sourceMaps: true,
        babel: {
          configFile: false,
          babelrc: false,
          optimize: { runtimeCodegen: false },
          plugins: [() => ({ generatorOverride: generate, visitor: {} })]
        }
      });
      expect(generate).toHaveBeenCalledOnce();
      expect(result.map?.sourcesContent).toEqual([source]);
      expect(result.code.includes('from "@mincho-js/css"')).toBe(read);
      expect(result.result[1]).toContain('color: "red"');
      const css = { css: (rule: { color: string }) => `class-${rule.color}` };
      const execute = (code: string, load: (id: string) => unknown) => {
        const module = { exports: {} };
        new Function(
          "module",
          "exports",
          "require",
          transformJsx(code, { format: "cjs" }).code
        )(module, module.exports, load);
        return module.exports;
      };
      const sidecar = execute(result.result[1], () => css);
      const runtime = execute(result.code, (id) =>
        id === result.result[0] ? sidecar : css
      );
      expect(runtime).toMatchObject({
        cls: "class-red",
        marker: "tail",
        ...(read ? { kind: "function" } : {})
      });
    }
  );

  it.each(["unused", "direct", "early", "block", "dead", "deferred"] as const)(
    "keeps initialization before a selected earlier ESM loader (%s)",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-esm-startup-"));
      afterTest(() => rm(root, { recursive: true, force: true }));
      const source =
        'import {observe} from "./observer.mjs";' +
        (mode === "early" ? "export const pending = observe();" : "") +
        'import {css} from "@mincho-js/css"; export const cls=css({color:"red"});' +
        {
          unused: "",
          direct: "export const pending = observe();",
          early: "",
          block: "export let pending; if (true) { pending = observe(); }",
          dead: "export let pending; if (false) { pending = observe(); }",
          deferred: "export function runLater() { return observe(); }"
        }[mode];
      const filename = join(root, "entry.mjs");
      await Promise.all([
        writeFile(filename, source),
        writeFile(join(root, "native.mjs"), source),
        writeFile(
          join(root, "package.json"),
          JSON.stringify({
            name: "@mincho-js/css",
            type: "module",
            exports: "./css.mjs"
          })
        ),
        writeFile(
          join(root, "css.mjs"),
          'trace.push("css-package");export const css=rule=>"class-"+rule.color;'
        ),
        writeFile(
          join(root, "observer.mjs"),
          'trace.push("load");export async function observe(){const ready=trace.includes("css-package");trace.push("observe");await import("@mincho-js/css");return ready;}'
        )
      ]);
      const result = await babelTransformSource({
        root,
        filename,
        source,
        babel: {
          configFile: false,
          babelrc: false,
          optimize: { runtimeCodegen: false }
        }
      });
      expect(result.result[1]).toContain('color: "red"');
      const emitted = [
        ...result.result[1].matchAll(/export\s+var\s+([\w$]+)/g)
      ];
      expect(emitted).toHaveLength(1);
      await writeFile(
        join(root, "sidecar.mjs"),
        `export const ${emitted[0]![1]}="class-red";`
      );
      await writeFile(
        filename,
        result.code.replace(result.result[0], "./sidecar.mjs")
      );
      const run = (file: string) =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `globalThis.trace=[];const m=await import("./${file}");console.log(JSON.stringify({trace,cls:m.cls,ready:await m.pending}));`
            ],
            {
              cwd: root,
              env: { ...process.env, NODE_OPTIONS: "" },
              encoding: "utf8"
            }
          )
        );
      const actual = run("entry.mjs");
      if (mode === "direct" || mode === "early" || mode === "block") {
        expect(actual).toEqual(run("native.mjs"));
        expect(actual).toEqual({
          trace: ["load", "css-package", "observe"],
          cls: "class-red",
          ready: true
        });
      } else expect(actual).toEqual({ trace: ["load"], cls: "class-red" });
    }
  );

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

describe("configured local extraction exports", () => {
  it.each([false, true])(
    "uses the final local export, retarget=%s",
    async (retarget) => {
      const pre = vi.fn();
      const result = await babelTransformSource({
        filename: "/virtual/factory.jsx",
        root: "/virtual",
        source: `
        import { style } from "@vanilla-extract/css";
        type Palette = {| color: string |};
        const first = rule => /* mincho-js-ignore */ style(rule);
        const second = rule => /* mincho-js-ignore */ style(rule);
        export { first as registered };
        export const oldValue = first({color:"red"});
        export const newValue = second({color:"blue"});
        export const App = () => <div css={{color:"green"}} />;
      `,
        babel: {
          configFile: false,
          babelrc: false,
          jsxCssProp: true,
          presets: [
            () => ({
              plugins: [
                (): PluginObj => ({
                  manipulateOptions(_options, parser) {
                    parser.plugins.push("flow");
                  },
                  pre(file) {
                    pre();
                    if (!retarget) return;
                    const declaration = file.ast.program.body.find(
                      (node) =>
                        t.isExportNamedDeclaration(node) &&
                        node.specifiers.some(
                          (spec) =>
                            t.isExportSpecifier(spec) &&
                            t.isIdentifier(spec.exported, {
                              name: "registered"
                            })
                        )
                    );
                    if (!t.isExportNamedDeclaration(declaration))
                      throw new Error("fixture registration missing");
                    const specifier = declaration.specifiers[0];
                    if (!t.isExportSpecifier(specifier))
                      throw new Error("fixture specifier missing");
                    specifier.local = t.identifier("second");
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
      expect(pre).toHaveBeenCalledOnce();
      const sidecar = result.result[1];
      const extracted = retarget ? "blue" : "red";
      const runtime = retarget ? "red" : "blue";
      expect(sidecar).toContain('color: "' + extracted + '"');
      expect(sidecar).not.toContain('color: "' + runtime + '"');
      expect(sidecar).toContain('color: "green"');
      expect(result.code).toContain('color: "' + runtime + '"');
      expect(result.code).not.toContain('color: "' + extracted + '"');
    }
  );
});

describe("autodiscovered Babel pre refresh", () => {
  it.each(["auto", "auto preset", "explicit", "disabled", "no-config"])(
    "keeps an imported JSX rule current with %s project configuration",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-pre-config-"));
      try {
        const configFile = join(root, "babel.config.cjs");
        const entry = join(root, "entry.jsx");
        const theme = join(root, "theme.js");
        const extra = join(root, "empty.js");
        const source =
          'import {rule} from "./theme.js"; export const App = () => <div css={rule} />;';
        const themeSource = 'export const rule = {color: "red"};';
        const active =
          mode === "auto" || mode === "auto preset" || mode === "explicit";
        if (mode !== "no-config") {
          await writeFile(
            configFile,
            `
            const {appendFileSync} = require("node:fs");
            const plugins = [({types:t}) => ({
              pre(file) {
                appendFileSync(file.opts.filename + ".pre-count", "hook");
                file.ast.program.body.unshift(t.importDeclaration([],t.stringLiteral("./empty.js")));
              },
              visitor: {
                Program(path, state) {
                  appendFileSync(state.filename + ".pre-count", ":visitor");
                }
              }
            })];
            module.exports = ${mode === "auto preset" ? "{ presets: [() => ({plugins})] }" : "{plugins}"};
          `
          );
        }
        await Promise.all([
          writeFile(entry, source),
          writeFile(theme, themeSource),
          writeFile(extra, "export {};")
        ]);
        const result = await babelTransformSource({
          filename: entry,
          source,
          root,
          sourceMaps: true,
          babel: {
            jsxCssProp: true,
            cwd: root,
            ...(mode === "explicit"
              ? { configFile }
              : mode === "disabled"
                ? { configFile: false, babelrc: false }
                : {}),
            staticCssEvalSourceProvider: {
              resolve: (_, id) =>
                id === "./theme.js"
                  ? { id: theme }
                  : id === "./empty.js"
                    ? { id: extra }
                    : null,
              load: (id) =>
                id === theme
                  ? { source: themeSource }
                  : id === extra
                    ? { source: "export {};" }
                    : null
            }
          }
        });
        expect(result.code.match(/\.\/empty\.js/g) ?? []).toHaveLength(
          active ? 1 : 0
        );
        expect(result.result[1]).toContain('color: "red"');
        expect(result.code).toContain("className");
        expect(result.code).not.toContain("css={");
        expect(result.map?.sourcesContent).toEqual([source]);
        if (active)
          expect(await readFile(entry + ".pre-count", "utf8")).toBe(
            "hook:visitor"
          );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ["new inline type-only re-export", false, false, true],
    ["type specifier on an existing value re-export", true, true, true],
    ["new mixed value/type re-export", false, true, false]
  ] as const)(
    "compares the emitted runtime surface for a %s",
    async (_form, existingValueExport, emittedEdge, keepsPreparedRule) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-type-reexport-"));
      afterTest(() => rm(root, { recursive: true, force: true }));
      const filename = join(root, "entry.tsx");
      const theme = join(root, "theme.js");
      const extra = join(root, "extra.ts");
      const themeSource = 'export const rule = {color: "red"};';
      const extraSource = "export type Color = string; export const value = 1;";
      const source = `
        import { rule } from "./theme.js";
        ${existingValueExport ? 'export { value } from "./extra.ts";' : ""}
        export const App = () => <div css={rule} />;
      `;
      await Promise.all([
        writeFile(filename, source),
        writeFile(theme, themeSource),
        writeFile(extra, extraSource)
      ]);
      const pre = vi.fn();
      const visitor = vi.fn();
      const result = await babelTransformSource({
        filename,
        source,
        root,
        sourceMaps: true,
        babel: {
          jsxCssProp: true,
          cwd: root,
          configFile: false,
          babelrc: false,
          plugins: [
            (): PluginObj => ({
              pre(file) {
                if (file.opts.filename === filename) pre();
              },
              visitor: {
                Program(program, state) {
                  if (state.filename !== filename) return;
                  visitor();
                  const typeSpecifier = t.exportSpecifier(
                    t.identifier("Color"),
                    t.identifier("Color")
                  );
                  typeSpecifier.exportKind = "type";
                  if (existingValueExport) {
                    const existing = program.node.body.find(
                      (statement): statement is t.ExportNamedDeclaration =>
                        t.isExportNamedDeclaration(statement) &&
                        statement.source?.value === "./extra.ts"
                    );
                    existing!.specifiers.push(typeSpecifier);
                  } else {
                    program.unshiftContainer(
                      "body",
                      t.exportNamedDeclaration(
                        null,
                        emittedEdge
                          ? [
                              typeSpecifier,
                              t.exportSpecifier(
                                t.identifier("value"),
                                t.identifier("value")
                              )
                            ]
                          : [typeSpecifier],
                        t.stringLiteral("./extra.ts")
                      )
                    );
                  }
                }
              }
            })
          ],
          staticCssEvalSourceProvider: {
            resolve: (_, id) =>
              id === "./theme.js"
                ? { id: theme }
                : id === "./extra.ts"
                  ? { id: extra }
                  : null,
            load: (id) =>
              id === theme
                ? { source: themeSource }
                : id === extra
                  ? { source: extraSource }
                  : null
          }
        }
      });
      expect(result.code.includes("./extra.ts")).toBe(emittedEdge);
      expect(result.code).not.toContain("Color");
      expect(result.result[1].includes('color: "red"')).toBe(keepsPreparedRule);
      expect(result.code).toContain("className");
      expect(result.code).not.toContain("css={");
      expect(result.map?.sourcesContent).toEqual([source]);
      expect(pre).toHaveBeenCalledTimes(1);
      expect(visitor).toHaveBeenCalledTimes(1);
    }
  );
});

describe("ordinary same-file registered styles with a destructured function member", () => {
  it.each(["direct", "default", "actual alias"])(
    "keeps local factory registration for %s",
    async (mode) => {
      const filename = "/virtual/factory.jsx";
      const root = "/virtual";
      const use =
        mode === "default"
          ? 'const { unrelated = () => "default" } = css; export const runtime = unrelated();'
          : mode === "actual alias"
            ? "const alias = css; export const other = alias();"
            : "";
      const transformed = await babelTransformSource({
        filename,
        root,
        source: `
        import { style } from "@vanilla-extract/css";
        const palette = { color: "red" };
        export function css() { return style(palette); }
        ${use}
        export const selected = css();
      `,
        babel: {
          configFile: false,
          babelrc: false,
          extractCalls: { "./factory.jsx": ["css"] },
          staticCssEvalSourceProvider: {
            resolve: (_from, id) =>
              id === "./factory.jsx" ? { id: filename } : null,
            load: () => null
          }
        }
      });
      if (mode === "actual alias") {
        // A direct alias still participates in the provider order proof.
        expect(transformed.result[1]).toBe("");
        expect(transformed.code).toContain("other = alias()");
        expect(transformed.code).toContain("selected = css()");
      } else {
        expect(transformed.result[1]).toContain('color: "red"');
        expect(transformed.code).not.toContain("selected = css()");
        if (mode === "default")
          expect(transformed.code).toContain("runtime = unrelated()");
      }
    }
  );
});
