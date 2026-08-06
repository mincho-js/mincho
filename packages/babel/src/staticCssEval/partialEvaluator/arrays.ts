import { types as t } from "@babel/core";
import type { PartialEvalResult } from "./result.js";
import type {
  PartialEvalReducerNodeOptions,
  PendingPartialEvalDeopt
} from "./reduction.js";

export function reduceArrayExpression(
  options: PartialEvalReducerNodeOptions<t.ArrayExpression>
): PartialEvalResult {
  const elements: t.ArrayExpression["elements"] = [];
  let pendingDeopt: PendingPartialEvalDeopt | null = null;

  for (const element of options.node.elements) {
    if (!element) {
      pendingDeopt ??= { reason: "runtime-css-shape", details: {} };
      elements.push(null);
      continue;
    }

    if (t.isSpreadElement(element)) {
      const spreadResult = options.runtime.reduceExpression({
        expression: element.argument,
        depth: options.depth + 1,
        reductionContext: options.reductionContext
      });

      if (spreadResult.kind === "deopt") {
        pendingDeopt ??= options.runtime.createPendingDeoptFromChild({
          result: spreadResult,
          reason: options.runtime.getContextualDeoptReason(
            spreadResult,
            "unsupported-spread"
          )
        });
        elements.push(
          t.spreadElement(t.cloneNode(spreadResult.fallbackExpression))
        );
        continue;
      }

      const spreadExpression = spreadResult.expression;

      if (!t.isArrayExpression(spreadExpression)) {
        pendingDeopt ??= {
          reason: "unsupported-spread",
          details: { deoptPath: [{ kind: "spread" }] }
        };
        elements.push(t.cloneNode(element));
        continue;
      }

      if (pushArraySpreadElements(elements, element, spreadExpression)) {
        pendingDeopt ??= {
          reason: "unsupported-spread",
          details: { deoptPath: [{ kind: "spread" }] }
        };
      }
      continue;
    }

    const elementResult = options.runtime.reduceExpression({
      expression: element,
      depth: options.depth + 1,
      reductionContext: options.reductionContext
    });

    if (elementResult.kind === "deopt") {
      pendingDeopt ??= options.runtime.createPendingDeoptFromChild({
        result: elementResult
      });
      elements.push(t.cloneNode(elementResult.fallbackExpression));
      continue;
    }

    elements.push(elementResult.expression);
  }

  const reducedExpression = t.arrayExpression(elements);

  return pendingDeopt
    ? options.runtime.createDeoptResult({
        expression: options.expression,
        reason: pendingDeopt.reason,
        details: {
          ...pendingDeopt.details,
          fallbackExpression: reducedExpression
        }
      })
    : options.runtime.createConfidentResult(reducedExpression);
}

export function getStaticArrayMemberValue(
  expression: t.ArrayExpression,
  memberName: string
): t.Expression | null {
  if (!/^\d+$/.test(memberName)) {
    return null;
  }

  const element = expression.elements[Number(memberName)];
  return element && t.isExpression(element) ? element : null;
}

function pushArraySpreadElements(
  elements: t.ArrayExpression["elements"],
  element: t.SpreadElement,
  spreadExpression: t.ArrayExpression
): boolean {
  const reducedElements: t.Expression[] = [];

  for (const spreadElement of spreadExpression.elements) {
    if (!spreadElement || t.isSpreadElement(spreadElement)) {
      elements.push(t.cloneNode(element));
      return true;
    }
    reducedElements.push(spreadElement);
  }

  elements.push(
    ...reducedElements.map((spreadElement) => t.cloneNode(spreadElement))
  );
  return false;
}
