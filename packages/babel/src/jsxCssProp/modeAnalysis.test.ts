import { parseSync, types as t } from "@babel/core";
import { describe, expect, it } from "vitest";
import { functionReturnsOnlyStaticPrimitive } from "./modeAnalysis.js";

function parseFunction(source: string): t.FunctionDeclaration {
  const statement = parseSync(source)?.program.body[0];

  if (!t.isFunctionDeclaration(statement)) {
    throw new TypeError("expected function declaration fixture");
  }

  return statement;
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
