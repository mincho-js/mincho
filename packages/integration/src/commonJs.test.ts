import { describe, expect, it, vi } from "vitest";
import { transform } from "esbuild";
import { runInNewContext } from "node:vm";
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
