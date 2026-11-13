import {
  type NodePath,
  parseSync,
  transformSync,
  types as t
} from "@babel/core";
import { describe, expect, it } from "vitest";
import {
  analyzeCssPropSidecarHoistability,
  containsImportedTopLevelArrayReference,
  functionReturnsOnlyStaticPrimitive
} from "./modeAnalysis.js";
import type { CssPropSidecarHoistability } from "./types.js";

function parseFunction(source: string): t.FunctionDeclaration {
  const statement = parseSync(source)?.program.body[0];

  if (!t.isFunctionDeclaration(statement)) {
    throw new TypeError("expected function declaration fixture");
  }

  return statement;
}

function hasImportedArrayReference(source: string): boolean {
  let result: boolean | undefined;

  transformSync(source, {
    parserOpts: { plugins: ["jsx"] },
    plugins: [
      () => ({
        visitor: {
          JSXAttribute(path: NodePath<t.JSXAttribute>) {
            if (!t.isJSXIdentifier(path.node.name, { name: "css" })) return;

            const value = path.node.value;

            if (
              t.isJSXExpressionContainer(value) &&
              t.isArrayExpression(value.expression)
            ) {
              result = containsImportedTopLevelArrayReference(
                value.expression,
                path.scope
              );
            }
          }
        }
      })
    ]
  });

  if (result === undefined) throw new TypeError("expected css array fixture");

  return result;
}

function analyzeSidecar(source: string): CssPropSidecarHoistability {
  let result: CssPropSidecarHoistability | undefined;

  transformSync(source, {
    parserOpts: {
      plugins: ["jsx", "typescript"],
      createParenthesizedExpressions: true
    },
    plugins: [
      () => ({
        visitor: {
          JSXAttribute(path: NodePath<t.JSXAttribute>) {
            if (!t.isJSXIdentifier(path.node.name, { name: "css" })) return;

            const value = path.node.value;

            if (
              t.isJSXExpressionContainer(value) &&
              t.isExpression(value.expression)
            ) {
              result = analyzeCssPropSidecarHoistability({
                expression: value.expression,
                scope: path.scope
              });
            }
          }
        }
      })
    ]
  });

  if (!result) throw new TypeError("expected css expression fixture");

  return result;
}

describe("sidecar destructuring patterns", () => {
  it.each([
    "const { size = fallback } = {};",
    "const [size = fallback] = [];",
    "const { values: [size = fallback] = [] } = {};",
    "const [{ size = fallback } = {}] = [];",
    "const { values: [size = fallback] = [4] } = { ...{ values: [] } };",
    "const { values: [size = fallback] = [4] } = { __proto__: { values: [] } };",
    "const { size = window.innerWidth } = {};",
    "const { [fallback]: size } = { value: 4 };",
    "const { values: { [fallback]: size } } = { values: { value: 4 } };",
    "const { [window.name]: size } = { value: 4 };",
    "const { size = (fallback(), 4) } = {};",
    "const [size = void fallback()] = [];",
    "const { [(fallback(), 'value')]: size } = { value: 4 };",
    "const { size = (fallback(), false) ? 8 : 4 } = {};",
    "const { size = (fallback(), 4) || 8 } = {};",
    "const { size = (true ? window.innerWidth : 4) as number } = {};",
    "const { size = (0 || window.innerWidth) satisfies number } = {};",
    "const { size = ((fallback(), false) ? 8 : 4) as number } = {};"
  ])("rejects unsafe pattern expressions: %s", (declaration) => {
    expect(
      analyzeSidecar(`
        import { getStyles } from "./theme.css.js";
        function App(fallback) {
          ${declaration}
          return <div css={getStyles(size)} />;
        }
      `)
    ).toEqual({ kind: "unsafe" });
  });

  it.each([
    "const { size = 4 } = {};",
    "const [size = 2 + 2] = [];",
    "const { values: [size = 4] = [] } = {};",
    "const [{ size = 4 } = {}] = [];",
    'const { ["val" + "ue"]: size } = { value: 4 };',
    "const { size = (0, 4) } = {};",
    "const { size = Math.max(2, 4) } = {};",
    "const { size = false ? fallback() : 4 } = {};",
    "const { size = 4 || fallback() } = {};",
    "const { size = (false ? window.innerWidth : 4) as number } = {};",
    "const { size = (4 || window.innerWidth) satisfies number } = {};",
    "const { size = (false ? window.innerWidth : 4)! } = {};",
    "const { values: [size = window.innerWidth] = [4] } = {};",
    "const [{ size = window.innerWidth } = { size: 4 }] = [];"
  ])("keeps safe pattern expressions hoistable: %s", (declaration) => {
    expect(
      analyzeSidecar(`
        import { getStyles } from "./theme.css.js";
        function App() {
          ${declaration}
          return <div css={getStyles(size)} />;
        }
      `)
    ).toEqual({ kind: "hoistable", cssValueClassification: "css-rule" });
  });

  it("does not resolve declaration globals against consumer-local constants", () => {
    expect(
      analyzeSidecar(`
        import { getStyles } from "./theme.css.js";
        const { size = fallback } = {};
        function App() {
          const fallback = 4;
          return <div css={getStyles(size)} />;
        }
      `)
    ).toEqual({ kind: "unsafe" });
  });
});

describe("sidecar primitive return analysis", () => {
  it("collects control-flow returns and skips nested functions", () => {
    expect(
      functionReturnsOnlyStaticPrimitive(
        parseFunction(`
          function candidate(flag) {
            if (flag) return "if";
            try { return 1; } catch { return false; }
            for (;;) { return null; }
            function nested() { return { color: "red" }; }
          }
        `)
      )
    ).toBe(true);
  });

  it("rejects non-primitive returns nested in loop bodies", () => {
    expect(
      functionReturnsOnlyStaticPrimitive(
        parseFunction(`
          function candidate(flag) {
            while (flag) { return { color: "red" }; }
            return "fallback";
          }
        `)
      )
    ).toBe(false);
  });
});

describe("sidecar array import analysis", () => {
  it("finds imported references inside nested arrays", () => {
    expect(
      hasImportedArrayReference(`
        import { rules } from "./rules";
        function App() {
          return <div css={[[...rules], { gap: 8 }]} />;
        }
      `)
    ).toBe(true);
  });

  it("ignores local bindings inside nested arrays", () => {
    expect(
      hasImportedArrayReference(`
        const rules = [{ color: "red" }];
        function App() {
          return <div css={[[...rules], { gap: 8 }]} />;
        }
      `)
    ).toBe(false);
  });
});
