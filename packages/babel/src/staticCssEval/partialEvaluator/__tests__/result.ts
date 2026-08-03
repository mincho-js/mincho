import { types as t } from "@babel/core";
import { createPartialEvalContext } from "../context.js";
import {
  createPartialEvalConfidentResult,
  createPartialEvalDeoptResult,
  formatPartialEvalDeoptReason,
  getPartialEvalResultExpression
} from "../result.js";
import { owner } from "./helpers.js";

export function registerPartialEvalResultTests(
  vitest: NonNullable<ImportMeta["vitest"]>
): void {
  const { describe, expect, it } = vitest;

  describe("partial evaluator result model", () => {
    it("creates confident and deopt result model helpers", () => {
      const expression = t.identifier("styles");
      const fallbackExpression = t.objectExpression([]);
      const context = createPartialEvalContext({
        owner,
        state: {
          depth: 1,
          nodeCount: 2,
          bindingStack: [
            {
              bindingName: "styles",
              memberPath: ["button"],
              owner
            }
          ]
        },
        limits: { maxDepth: 3 }
      });

      const confident = createPartialEvalConfidentResult({
        expression,
        metadata: context.metadata
      });
      const deopt = createPartialEvalDeoptResult({
        originalExpression: expression,
        fallbackExpression,
        reason: "unsupported-call-expression",
        owner,
        bindingName: "styles",
        memberPath: ["button"],
        detail: "custom detail",
        deoptPath: [{ kind: "binding", name: "styles" }]
      });

      expect(context.policy.kind).toBe("jsx-css-prop");
      expect(context.policy.providerValueMode).toBe("value-to-fresh-ast");
      expect(context.limits.maxDepth).toBe(3);
      expect(context.state.bindingStack[0]?.memberPath).toEqual(["button"]);
      expect(confident.kind).toBe("confident");
      expect(confident.confident).toBe(true);
      expect(getPartialEvalResultExpression(confident)).toBe(expression);
      expect(deopt.kind).toBe("deopt");
      expect(deopt.confident).toBe(false);
      expect(deopt.reason).toBe("unsupported-call-expression");
      expect(deopt.diagnostic.code).toBe("unsupported-syntax");
      expect(deopt.diagnostic.bindingName).toBe("styles");
      expect(deopt.diagnostic.detail).toBe("custom detail");
      expect(deopt.diagnostic.memberPath).toEqual(["button"]);
      expect(deopt.diagnostic.deoptPath).toEqual([
        { kind: "binding", name: "styles" }
      ]);
      expect(getPartialEvalResultExpression(deopt)).toBe(fallbackExpression);
      expect(formatPartialEvalDeoptReason("unsupported-computed-member")).toBe(
        "computed member access is unsupported"
      );
    });
  });
}
