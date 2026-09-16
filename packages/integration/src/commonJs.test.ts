import { describe, expect, it, vi } from "vitest";
import { transform } from "esbuild";
import { runInNewContext } from "node:vm";
import * as minchoBabel from "@mincho-js/babel";
import { transformCommonJsToEsm } from "./commonJs.js";
import {
  babelTransformSource,
  type StaticCssEvalSourceProvider
} from "./babel.js";

async function normalize(source: string, modules: Record<string, string> = {}) {
  const resolve = vi.fn(
    (
      _importer: string,
      source: string,
      _options?: { kind: "import" | "require" }
    ) => {
      if (!Object.hasOwn(modules, source)) return null;

      return {
        id: `/project/${source.replace(/^\.\//, "")}`,
        sourceKind: "project-source" as const
      };
    }
  );

  const provider: StaticCssEvalSourceProvider = {
    resolve,

    load(id) {
      const source = modules[`./${id.split("/").pop()}`];

      return source === undefined ? null : { sourceText: source };
    }
  };

  const result = await babelTransformSource({
    filename: "/project/entry.cjs",
    source,
    commonJsToEsm: true,
    sourceMaps: true,
    babel: {
      babelrc: false,
      configFile: false,
      staticCssEvalSourceProvider: provider
    }
  });

  return { ...result, resolve };
}

async function execute(
  code: string,
  dependencies: Record<string, unknown> = {}
) {
  const output = await transform(code, { format: "cjs" });
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(output.code, {
    module,
    exports: module.exports,

    require: (id: string) => dependencies[id]
  });

  return module.exports;
}

describe("CommonJS browser normalization", () => {
  it.each([
    'export const load = () => require("./helper.cjs");',
    'export const value = false && require("./helper.cjs");',
    "export function load(name) { return require(name); }"
  ])("preserves ESM with guarded or lazy requires: %s", async (source) => {
    const result = await normalize(source, {
      "./helper.cjs": "module.exports = 42;"
    });

    expect(result.code).toContain("require(");
    expect(result.code).not.toContain('from "/project/helper.cjs"');
    expect(result.code).not.toContain("cjsModule");
  });

  it("skips inspecting ordinary ESM that has already been parsed by Babel", async () => {
    const inspect = vi.spyOn(minchoBabel, "internalInspectCommonJs");

    try {
      const result = await transformCommonJsToEsm({
        filename: "/project/entry.js",
        source: "export const answer = 42;",
        dependencies: new Set(),
        sidecar: "",
        sourceMaps: false
      });

      expect(result).toBeNull();
      expect(inspect).not.toHaveBeenCalled();
    } finally {
      inspect.mockRestore();
    }
  });

  it.each([
    String.raw`m\u006fdule.exp\u006frts = 42;`,
    String.raw`exp\u{6f}rts.answer = 42;`
  ])("still normalizes escaped CommonJS identifiers: %s", async (source) => {
    const result = await transformCommonJsToEsm({
      filename: "/project/entry.cjs",
      source,
      dependencies: new Set(),
      sidecar: "",
      sourceMaps: false
    });

    expect(result?.code).toBeDefined();
    const output = await execute(result!.code!);
    expect(output.answer ?? output.default).toBe(42);
  });

  it.each([
    'module.exports = require("./helper.cjs") || 0;',
    'module.exports = require("./helper.cjs") && 42;',
    'module.exports = require("./helper.cjs") ?? 0;',
    'module.exports = require("./helper.cjs") ? 42 : 0;',
    'let value = 0; if (require("./helper.cjs")) value = 42; module.exports = value;'
  ])(
    "normalizes an unconditional require in a condition: %s",
    async (source) => {
      const result = await normalize(source, {
        "./helper.cjs": "module.exports = 42;"
      });
      const output = await execute(result.code, {
        "/project/helper.cjs": { __esModule: true, default: 42 }
      });

      expect(output.default).toBe(42);
      expect(result.code).not.toMatch(/\brequire\s*\(/);
    }
  );

  it("leaves resolved CSS sidecars to the bundler instead of parsing their contents", async () => {
    const result = await normalize(
      'require("./style.css"); exports.answer = 42;',
      {
        "./style.css": ".fixture { color: red; }"
      }
    );

    expect(result.code).toContain('from "/project/style.css"');
    expect(result.code).not.toContain('require("./style.css")');
    expect((await execute(result.code)).answer).toBe(42);
  });

  it("keeps a callable module value distinct from its default property", async () => {
    const result = await normalize(
      "module.exports = () => 1; module.exports.default = () => 2;"
    );

    const output = await execute(result.code);
    const value = output.default as (() => number) & { default: () => number };

    expect(value()).toBe(1);
    expect(value.default()).toBe(2);
  });

  it("preserves named exports and the exact module.exports value", async () => {
    const result = await normalize(
      "exports.old = 1; module.exports = { answer: 42 }; exports.stale = 2;"
    );

    const output = await execute(result.code);

    expect(output.default).toEqual({ answer: 42 });
    expect(output.answer).toBe(42);
    expect(output).not.toHaveProperty("old");
    expect(result.commonJsTransformed).toBe(true);
    expect(result.map?.sourcesContent).toEqual([
      "exports.old = 1; module.exports = { answer: 42 }; exports.stale = 2;"
    ]);
  });

  it("resolves runtime dependencies with require conditions and keeps explicit default distinct", async () => {
    const result = await normalize(
      'const helper = require("./helper.cjs"); exports.answer = helper.default();',
      {
        "./helper.cjs": "exports.default = () => 42;"
      }
    );

    expect(result.resolve).toHaveBeenCalledWith(
      "/project/entry.cjs",
      "./helper.cjs",
      { kind: "require" }
    );
    expect(result.staticCssEval?.dependencyFiles).toContain(
      "/project/helper.cjs"
    );

    const output = await execute(result.code, {
      "/project/helper.cjs": {
        __esModule: true,
        default: { default: () => 42 }
      }
    });

    expect(output.answer).toBe(42);
  });

  it("uses the callable CommonJS value of an unresolved Node builtin", async () => {
    const result = await normalize(
      'const assert = require("node:assert/strict"); assert(true); exports.kind = typeof assert;'
    );
    const assert = vi.fn();
    const output = await execute(result.code, {
      "node:assert/strict": { __esModule: true, default: assert }
    });

    expect(output.kind).toBe("function");
    expect(assert).toHaveBeenCalledWith(true);
  });

  it("keeps the canonical Node builtin ID of an external alias", async () => {
    const result = await babelTransformSource({
      filename: "/project/entry.cjs",
      source:
        'const assert = require("assert-alias"); assert(true); exports.kind = typeof assert;',
      commonJsToEsm: true,
      babel: {
        babelrc: false,
        configFile: false,
        staticCssEvalSourceProvider: {
          resolve: () => ({
            id: "virtual:external-assert",
            canonicalModuleId: "node:assert/strict",
            sourceKind: "external-no-source"
          }),
          load: () => null
        }
      }
    });
    const assert = vi.fn();
    const output = await execute(result.code, {
      "node:assert/strict": { __esModule: true, default: assert }
    });

    expect(output.kind).toBe("function");
    expect(assert).toHaveBeenCalledWith(true);
  });

  it("preserves a provider's runtime ID for an opaque external alias", async () => {
    const result = await babelTransformSource({
      filename: "/project/entry.cjs",
      source: 'exports.answer = require("external-alias").answer;',
      commonJsToEsm: true,
      babel: {
        babelrc: false,
        configFile: false,
        staticCssEvalSourceProvider: {
          resolve: () => ({
            id: "virtual:external-target",
            canonicalModuleId: "external-target",
            sourceKind: "external-no-source"
          }),
          load: () => null
        }
      }
    });
    const output = await execute(result.code, {
      "external-target": { __esModule: true, answer: 42 }
    });

    expect(output.answer).toBe(42);
  });

  it("rejects unknown whole-module re-exports from Node builtins", async () => {
    await expect(
      normalize('module.exports = require("node:fs");')
    ).rejects.toThrow(/Cannot identify CommonJS re-exports/);
  });

  it("uses explicit properties of CommonJS external runtimes while rejecting unknown re-export names", async () => {
    const babel = {
      babelrc: false,
      configFile: false as const,
      staticCssEvalSourceProvider: {
        resolve: () => ({
          id: "virtual:external-cjs",
          commonJsRuntimeId: "virtual:external-runtime",
          sourceKind: "external-no-source" as const
        }),
        load: () => null
      }
    };
    const result = await babelTransformSource({
      filename: "/project/entry.cjs",
      source: 'exports.answer = require("external-cjs").answer;',
      commonJsToEsm: true,
      babel
    });

    expect(
      await execute(result.code, {
        "virtual:external-runtime": {
          __esModule: true,
          default: { answer: 42 }
        }
      })
    ).toMatchObject({ answer: 42 });

    await expect(
      babelTransformSource({
        filename: "/project/entry.cjs",
        source: 'module.exports = require("external-cjs");',
        commonJsToEsm: true,
        babel
      })
    ).rejects.toThrow(/Cannot identify CommonJS re-exports/);
  });

  it("retains live getter re-exports from ESM dependencies", async () => {
    const result = await normalize(
      'const dep = require("./helper.mjs"); Object.defineProperty(exports, "answer", { enumerable: true, get: function () { return dep.answer; } });',
      {
        "./helper.mjs": "export let answer = 1;"
      }
    );

    const dependency = { __esModule: true, answer: 1 };
    const output = await execute(result.code, {
      "/project/helper.mjs": dependency
    });

    expect(output.answer).toBe(1);

    dependency.answer = 2;

    expect(output.answer).toBe(2);
  });

  it("does not modify an ESM-only input", async () => {
    const result = await normalize("export const answer = 42;");

    expect(result.commonJsTransformed).toBeUndefined();
    expect(result.code).toContain("export const answer = 42");
  });

  it("preserves snapshots for assignments and live values for local getters", async () => {
    const result = await normalize(
      'const dep = require("./helper.mjs"); exports.snapshot = dep.answer; let count = 1; Object.defineProperty(exports, "count", {enumerable:true, get: function () { return count; }}); exports.increment = () => ++count;',
      { "./helper.mjs": "export let answer = 1;" }
    );

    const dependency = { __esModule: true, answer: 1 };
    const output = await execute(result.code, {
      "/project/helper.mjs": dependency
    });

    dependency.answer = 2;
    (output.increment as () => void)();

    expect(output.snapshot).toBe(1);
    expect(output.count).toBe(2);
  });

  it("forwards named ESM exports through module.exports", async () => {
    const result = await normalize(
      'module.exports = require("./helper.mjs");',
      {
        "./helper.mjs": "export let answer = 42;"
      }
    );

    const dependency = { __esModule: true, answer: 42 };
    const output = await execute(result.code, {
      "/project/helper.mjs": dependency
    });

    expect(output.answer).toBe(42);

    dependency.answer = 43;

    expect(output.answer).toBe(43);
    expect(output.default).toMatchObject({ answer: 43 });
  });

  it("rejects dynamic require instead of emitting a browser require call", async () => {
    await expect(
      normalize("module.exports = require(target);")
    ).rejects.toThrow(/Dynamic require/);
  });

  it("rejects lazy runtime loading rather than eagerly executing the dependency", async () => {
    await expect(
      normalize('exports.load = () => require("./helper.cjs");', {
        "./helper.cjs": 'throw new Error("must stay lazy");'
      })
    ).rejects.toThrow(/Conditional or lazy require/);
  });

  it.each([
    'class A { field = require("./helper.cjs"); } module.exports = A;',
    'class A { #field = require("./helper.cjs"); } module.exports = A;',
    'let value; value ||= require("./helper.cjs");',
    'let value; value &&= require("./helper.cjs");',
    'let value; value ??= require("./helper.cjs");',
    'fn?.(require("./helper.cjs"));',
    'fn?.method(require("./helper.cjs"));'
  ])(
    "rejects hoisting a deferred or short-circuited dependency: %s",
    async (source) => {
      await expect(
        normalize(source, {
          "./helper.cjs": 'throw new Error("must stay lazy");'
        })
      ).rejects.toThrow(/Conditional or lazy require/);
    }
  );
});

it("uses configured Babel syntax when inferring the input format", async () => {
  const result = await babelTransformSource({
    filename: "/project/entry.js",
    source: "@decorate class Example {} export {Example};",
    babel: {
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["decorators"] }
    }
  });

  expect(result.code).toContain("@decorate");
});

it.each(["export { Example };", "module.exports = Example;"])(
  "preserves configured syntax through CommonJS inspection: %s",
  async (exports) => {
    const result = await babelTransformSource({
      filename: "/project/entry.tsx",
      source: `@decorate class Example { value: number = 42; view = <div />; } ${exports}`,
      commonJsToEsm: true,
      babel: {
        configFile: false,
        babelrc: false,
        parserOpts: {
          plugins: [["decorators", { decoratorsBeforeExport: true }]]
        }
      }
    });

    expect(result.code).toContain("@decorate");
    expect(result.code).toContain("<div />");
    expect(result.code).not.toContain(": number");
    expect(result.code).not.toContain("module.exports");
    expect(result.commonJsTransformed).toBe(
      exports.startsWith("module") ? true : undefined
    );
  }
);

it("uses configured syntax while inspecting required modules", async () => {
  const result = await babelTransformSource({
    filename: "/project/entry.js",
    source: 'module.exports = require("./helper.tsx");',
    commonJsToEsm: true,
    babel: {
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["decorators"] },
      staticCssEvalSourceProvider: {
        resolve: () => ({ id: "/project/helper.tsx" }),
        load: () => ({
          sourceText:
            "@decorate class Example { value: number = 42; view = <div />; } exports.Example = Example;"
        })
      }
    }
  });

  expect(result.code).toContain('from "/project/helper.tsx"');
  expect(result.code).toContain("export");
  expect(result.code).toContain("Example");
  expect(result.code).not.toContain("require(");
});

it("preserves a JSX loader override through CommonJS inspection", async () => {
  const result = await babelTransformSource({
    filename: "/project/entry.js",
    loader: "jsx",
    source: "exports.View = () => <div />;",
    commonJsToEsm: true,
    babel: { babelrc: false, configFile: false }
  });

  expect(result.commonJsTransformed).toBe(true);
  expect(result.code).toContain("<div />");
  expect(result.code).not.toContain("exports.View");
});

it("retains resolved dependencies when CommonJS source loading fails", async () => {
  const result = babelTransformSource({
    filename: "/project/entry.cjs",
    source: 'module.exports = require("./helper.cjs");',
    commonJsToEsm: true,
    babel: {
      babelrc: false,
      configFile: false,
      staticCssEvalSourceProvider: {
        resolve: () => ({ id: "/project/helper.cjs" }),
        load: () => {
          throw new Error("temporary load failure");
        }
      }
    }
  });

  await expect(result).rejects.toMatchObject({
    message: "temporary load failure",
    staticCssEval: { dependencyFiles: ["/project/helper.cjs"] }
  });
});

it("keeps import and require conditions separate in the JSX static prepass", async () => {
  const calls: string[] = [];
  const provider: StaticCssEvalSourceProvider = {
    resolve(_importer, source, options) {
      if (source !== "styles") return null;

      const kind = options?.kind ?? "import";
      calls.push(kind);

      return { id: `/project/${kind}.js`, sourceKind: "project-source" };
    },

    load(id) {
      return {
        sourceText: id.endsWith("require.js")
          ? 'exports.rules = {color: "blue"};'
          : 'export const rules = {color: "red"};'
      };
    }
  };

  const result = await babelTransformSource({
    filename: "/project/entry.tsx",
    loader: "tsx",
    source:
      'import {rules as esm} from "styles"; const {rules: cjs} = require("styles"); export const View = () => <><div css={esm}/><div css={cjs}/></>;',
    babel: {
      jsxCssProp: true,
      staticCssEvalSourceProvider: provider,
      babelrc: false,
      configFile: false
    }
  });

  expect(calls).toEqual(["import", "require"]);
  expect(result.result[1]).toContain('color: "red"');
  expect(result.result[1]).toContain('color: "blue"');
});

it("extracts namespace calls in actual esbuild CommonJS output", async () => {
  const compiled = await transform(
    'import * as styles from "@vanilla-extract/css"; export const cls = styles.style({color:"red"});',
    { format: "cjs" }
  );

  const result = await babelTransformSource({
    filename: "/project/compiled.cjs",
    source: compiled.code,
    babel: { babelrc: false, configFile: false }
  });

  expect(result.result[1]).toContain('color: "red"');
  expect(result.code).not.toContain('color: "red"');
});
