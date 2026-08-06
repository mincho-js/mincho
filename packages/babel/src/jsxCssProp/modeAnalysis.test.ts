import {
  type NodePath,
  parseSync,
  transformSync,
  types as t
} from "@babel/core";
import { describe, expect, it } from "vitest";
import {
  containsImportedTopLevelArrayReference,
  functionReturnsOnlyStaticPrimitive
} from "./modeAnalysis.js";

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
