import type { NodePath, types as t } from "@babel/core";

export function hasUnsafeConditionExpression(
  path: NodePath<t.Expression>
): boolean {
  if (
    path.isAssignmentExpression() ||
    path.isUpdateExpression() ||
    path.isCallExpression() ||
    path.isOptionalCallExpression() ||
    path.isTaggedTemplateExpression() ||
    path.isNewExpression() ||
    path.isAwaitExpression() ||
    path.isYieldExpression() ||
    (path.isLogicalExpression() &&
      (path.node.operator === "||" || path.node.operator === "??"))
  ) {
    return true;
  }

  let unsafe = false;

  path.traverse({
    AssignmentExpression(expressionPath) {
      unsafe = true;
      expressionPath.stop();
    },
    LogicalExpression(expressionPath) {
      if (
        expressionPath.node.operator === "||" ||
        expressionPath.node.operator === "??"
      ) {
        unsafe = true;
        expressionPath.stop();
      }
    },
    UpdateExpression(expressionPath) {
      unsafe = true;
      expressionPath.stop();
    },
    CallExpression(expressionPath) {
      unsafe = true;
      expressionPath.stop();
    },
    OptionalCallExpression(expressionPath) {
      unsafe = true;
      expressionPath.stop();
    },
    TaggedTemplateExpression(expressionPath) {
      unsafe = true;
      expressionPath.stop();
    },
    NewExpression(expressionPath) {
      unsafe = true;
      expressionPath.stop();
    },
    AwaitExpression(expressionPath) {
      unsafe = true;
      expressionPath.stop();
    },
    YieldExpression(expressionPath) {
      unsafe = true;
      expressionPath.stop();
    }
  });

  return unsafe;
}
