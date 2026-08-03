import { types as t } from "@babel/core";
import type { PartialEvalResult } from "./result.js";
import type { PartialEvalReducerNodeOptions } from "./reduction.js";
import { getStaticPrimitiveValue } from "./literals.js";

export function reduceTemplateLiteral(
  options: PartialEvalReducerNodeOptions<t.TemplateLiteral>
): PartialEvalResult {
  let value = "";

  for (let index = 0; index < options.node.quasis.length; index += 1) {
    const quasi = options.node.quasis[index];

    if (!quasi) {
      continue;
    }

    value += quasi.value.cooked ?? quasi.value.raw;

    const interpolation = options.node.expressions[index];

    if (!interpolation) {
      continue;
    }

    if (!t.isExpression(interpolation)) {
      return options.runtime.createDeoptResult({
        expression: options.expression,
        reason: "unsupported-template-interpolation"
      });
    }

    const interpolationResult = options.runtime.reduceExpression({
      expression: interpolation,
      depth: options.depth + 1,
      reductionContext: options.reductionContext
    });

    if (interpolationResult.kind === "deopt") {
      return options.runtime.createDeoptFromChild({
        expression: options.expression,
        result: interpolationResult,
        reason:
          interpolationResult.reason === "unsupported-call-expression"
            ? "unsupported-call-expression"
            : options.runtime.getContextualDeoptReason(
                interpolationResult,
                "unsupported-template-interpolation"
              )
      });
    }

    const primitiveValue = getStaticPrimitiveValue(
      interpolationResult.expression
    );

    if (primitiveValue === undefined) {
      return options.runtime.createDeoptResult({
        expression: options.expression,
        reason: "unsupported-template-interpolation"
      });
    }

    value += String(primitiveValue);
  }

  return options.runtime.createConfidentResult(t.stringLiteral(value));
}
