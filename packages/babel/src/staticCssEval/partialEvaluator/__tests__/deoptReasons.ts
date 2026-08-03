import { types as t } from "@babel/core";
import {
  PARTIAL_EVAL_DEOPT_REASONS,
  createPartialEvalDeoptResult,
  type PartialEvalDeoptReason
} from "../result.js";
import { owner } from "./helpers.js";

const requiredDeoptReasons = [
  "mutated-binding",
  "unsupported-import",
  "unsupported-call-expression",
  "non-static-object-key",
  "unsupported-spread",
  "unsupported-computed-member",
  "runtime-css-shape",
  "unsupported-template-interpolation",
  "cycle-detected",
  "depth-limit",
  "node-count-limit"
] as const satisfies readonly PartialEvalDeoptReason[];

export function registerPartialEvalDeoptReasonTests(
  vitest: NonNullable<ImportMeta["vitest"]>
): void {
  const { describe, expect, it } = vitest;

  describe("partial evaluator deopt reasons", () => {
    it("constructs every required deopt reason", () => {
      const results = PARTIAL_EVAL_DEOPT_REASONS.map((reason) =>
        createPartialEvalDeoptResult({
          originalExpression: createReasonExpression(reason),
          reason,
          owner
        })
      );

      expect(PARTIAL_EVAL_DEOPT_REASONS).toEqual(requiredDeoptReasons);
      expect(results.map((result) => result.reason)).toEqual(
        requiredDeoptReasons
      );
      expect(
        results.map((result) => ({
          reason: result.reason,
          code: result.diagnostic.code,
          message: result.diagnostic.message
        }))
      ).toEqual([
        {
          reason: "mutated-binding",
          code: "mutation-detected",
          message:
            "Cannot partially evaluate css prop value: binding is mutated"
        },
        {
          reason: "unsupported-import",
          code: "unsupported-source",
          message:
            "Cannot partially evaluate css prop value: imported binding must be resolved by the static css provider"
        },
        {
          reason: "unsupported-call-expression",
          code: "unsupported-syntax",
          message:
            "Cannot partially evaluate css prop value: call expressions are not evaluated by Babel"
        },
        {
          reason: "non-static-object-key",
          code: "unsupported-syntax",
          message:
            "Cannot partially evaluate css prop value: object key is not statically known"
        },
        {
          reason: "unsupported-spread",
          code: "unsupported-syntax",
          message:
            "Cannot partially evaluate css prop value: spread operand is not statically reducible"
        },
        {
          reason: "unsupported-computed-member",
          code: "unsupported-syntax",
          message:
            "Cannot partially evaluate css prop value: computed member access is unsupported"
        },
        {
          reason: "runtime-css-shape",
          code: "unsupported-syntax",
          message:
            "Cannot partially evaluate css prop value: runtime CSS object shape is unsupported"
        },
        {
          reason: "unsupported-template-interpolation",
          code: "unsupported-syntax",
          message:
            "Cannot partially evaluate css prop value: template interpolation is not a static primitive"
        },
        {
          reason: "cycle-detected",
          code: "cycle-detected",
          message:
            "Cannot partially evaluate css prop value: binding cycle detected"
        },
        {
          reason: "depth-limit",
          code: "limit-exceeded",
          message:
            "Cannot partially evaluate css prop value: partial evaluator depth limit exceeded"
        },
        {
          reason: "node-count-limit",
          code: "limit-exceeded",
          message:
            "Cannot partially evaluate css prop value: partial evaluator node count limit exceeded"
        }
      ]);
    });

    it("exhaustively handles every deopt reason", () => {
      expect(PARTIAL_EVAL_DEOPT_REASONS.map(handleDeoptReasonForTest)).toEqual([
        "mutation",
        "import",
        "call",
        "object-key",
        "spread",
        "computed-member",
        "runtime-shape",
        "template",
        "cycle",
        "depth",
        "node-count"
      ]);
    });
  });
}

function createReasonExpression(reason: PartialEvalDeoptReason): t.Expression {
  return t.identifier(reason.replaceAll("-", "_"));
}

function handleDeoptReasonForTest(reason: PartialEvalDeoptReason): string {
  switch (reason) {
    case "mutated-binding":
      return "mutation";
    case "unsupported-import":
      return "import";
    case "unsupported-call-expression":
      return "call";
    case "non-static-object-key":
      return "object-key";
    case "unsupported-spread":
      return "spread";
    case "unsupported-computed-member":
      return "computed-member";
    case "runtime-css-shape":
      return "runtime-shape";
    case "unsupported-template-interpolation":
      return "template";
    case "cycle-detected":
      return "cycle";
    case "depth-limit":
      return "depth";
    case "node-count-limit":
      return "node-count";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
