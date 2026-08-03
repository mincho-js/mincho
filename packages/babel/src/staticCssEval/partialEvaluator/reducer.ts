import { types as t } from "@babel/core";
import { unwrapTransparentCssRuleExpression } from "../candidates.js";
import type { PartialEvalOptions } from "./context.js";
import type { PartialEvalResult } from "./result.js";
import { reduceArrayExpression } from "./arrays.js";
import { reduceBinaryExpression } from "./binary.js";
import { reduceIdentifierExpression } from "./bindings.js";
import { isStaticPrimitiveLiteralExpression } from "./literals.js";
import { reduceMemberExpression } from "./members.js";
import { reduceObjectExpression } from "./objects.js";
import { reduceLogicalExpression, reduceUnaryExpression } from "./operators.js";
import {
  createPartialEvalReducerRuntime,
  type PartialEvalReductionContext,
  type ReducePartialEvalExpressionOptions
} from "./reduction.js";
import { reduceTemplateLiteral } from "./templates.js";

export function reducePartialEvalExpression(
  options: PartialEvalOptions
): PartialEvalResult {
  let visitedNodeCount = options.context.state.nodeCount;
  const initialReductionContext: PartialEvalReductionContext = {
    bindingStack: options.context.state.bindingStack,
    ...(options.programPath !== undefined
      ? { programPath: options.programPath }
      : {}),
    ...(options.scope !== undefined ? { scope: options.scope } : {})
  };

  function reduceExpression(
    reduceOptions: ReducePartialEvalExpressionOptions
  ): PartialEvalResult {
    const { expression, depth, reductionContext } = reduceOptions;
    visitedNodeCount += 1;

    if (visitedNodeCount > options.context.limits.maxNodeCount) {
      return runtime.createDeoptResult({
        expression,
        reason: "node-count-limit"
      });
    }

    if (depth > options.context.limits.maxDepth) {
      return runtime.createDeoptResult({ expression, reason: "depth-limit" });
    }

    const node = unwrapTransparentCssRuleExpression(expression);

    if (t.isUnaryExpression(node)) {
      return reduceUnaryExpression({
        expression,
        node,
        depth,
        reductionContext,
        runtime
      });
    }

    if (isStaticPrimitiveLiteralExpression(node)) {
      return runtime.createConfidentResult(t.cloneNode(node));
    }

    if (t.isTemplateLiteral(node)) {
      return reduceTemplateLiteral({
        expression,
        node,
        depth,
        reductionContext,
        runtime
      });
    }

    if (t.isObjectExpression(node)) {
      return reduceObjectExpression({
        expression,
        node,
        depth,
        reductionContext,
        runtime
      });
    }

    if (t.isArrayExpression(node)) {
      return reduceArrayExpression({
        expression,
        node,
        depth,
        reductionContext,
        runtime
      });
    }

    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      return reduceMemberExpression({
        expression,
        node,
        depth,
        reductionContext,
        runtime
      });
    }

    if (t.isIdentifier(node)) {
      return reduceIdentifierExpression({
        expression,
        node,
        depth,
        reductionContext,
        runtime
      });
    }

    if (t.isBinaryExpression(node)) {
      return reduceBinaryExpression({
        expression,
        node,
        depth,
        reductionContext,
        runtime
      });
    }

    if (t.isLogicalExpression(node)) {
      return reduceLogicalExpression({
        expression,
        node,
        depth,
        reductionContext,
        runtime
      });
    }

    if (
      t.isCallExpression(node) ||
      t.isOptionalCallExpression(node) ||
      t.isNewExpression(node)
    ) {
      return runtime.createDeoptResult({
        expression,
        reason: "unsupported-call-expression"
      });
    }

    return runtime.createDeoptResult({
      expression,
      reason: "runtime-css-shape"
    });
  }

  const runtime = createPartialEvalReducerRuntime(
    options.context,
    reduceExpression
  );

  return reduceExpression({
    expression: options.expression,
    depth: options.context.state.depth,
    reductionContext: initialReductionContext
  });
}
