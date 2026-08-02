import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
import { isSidecarSafeFunctionLike } from "./sidecarFunctionSafety.js";
import {
  hasSidecarBranch,
  isSidecarRuleCallExpression,
  isSidecarSafeLiteral
} from "./sidecarShape.js";

type AnalysisScope = NodePath<t.JSXOpeningElement>["scope"];
type SidecarBinding = NonNullable<ReturnType<AnalysisScope["getBinding"]>>;
const buildTimeSafeGlobalNames = new Set([
  "Math",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "JSON",
  "undefined",
  "NaN",
  "Infinity"
]);

export type SidecarSafetyState = {
  readonly scope: AnalysisScope;
  readonly visiting: ReadonlySet<SidecarBinding>;
  readonly localNames: ReadonlySet<string>;
};

export function isSidecarSafeCssRuleExpression(options: {
  readonly expression: t.Expression;
  readonly rawExpression?: t.Expression;
  readonly state: SidecarSafetyState;
}): boolean {
  const expression = unwrapTransparentCssRuleExpression(options.expression);
  const rawExpression = options.rawExpression
    ? unwrapTransparentCssRuleExpression(options.rawExpression)
    : null;

  if (
    rawExpression &&
    !isSidecarSafePreservedRawCssRuleExpression(
      rawExpression,
      expression,
      options.state
    )
  ) {
    return false;
  }

  return isSidecarSafeCssRuleExpressionNode(expression, options.state);
}

function isSidecarSafeCssRuleExpressionNode(
  expression: t.Expression,
  state: SidecarSafetyState
): boolean {
  if (isSidecarRuleCallExpression(expression, state.scope)) {
    return (
      t.isExpression(expression.callee) &&
      isSidecarSafeExpression(expression.callee, state) &&
      expression.arguments.every((argument) =>
        t.isSpreadElement(argument)
          ? isSidecarSafeExpression(argument.argument, state)
          : t.isExpression(argument) && isSidecarSafeExpression(argument, state)
      )
    );
  }

  if (t.isObjectExpression(expression)) {
    return isSidecarSafeObjectExpression(expression, state);
  }

  if (t.isArrayExpression(expression)) {
    return isSidecarSafeArrayExpression(expression, state);
  }

  if (t.isConditionalExpression(expression)) {
    return (
      isSidecarSafeCssRuleBranch(expression.consequent, state) &&
      isSidecarSafeCssRuleBranch(expression.alternate, state)
    );
  }

  if (t.isLogicalExpression(expression)) {
    return (
      isSidecarSafeCssRuleBranch(expression.left, state) &&
      isSidecarSafeCssRuleBranch(expression.right, state)
    );
  }

  return true;
}

function isSidecarSafePreservedRawCssRuleExpression(
  rawExpression: t.Expression,
  expression: t.Expression,
  state: SidecarSafetyState
): boolean {
  if (t.isObjectExpression(rawExpression) && t.isObjectExpression(expression)) {
    return isSidecarSafeObjectExpression(rawExpression, state);
  }

  if (t.isArrayExpression(rawExpression) && t.isArrayExpression(expression)) {
    return isSidecarSafeArrayExpression(rawExpression, state);
  }

  if (
    t.isConditionalExpression(rawExpression) &&
    t.isConditionalExpression(expression)
  ) {
    return (
      isSidecarSafeCssRuleBranch(rawExpression.consequent, state) &&
      isSidecarSafeCssRuleBranch(rawExpression.alternate, state)
    );
  }

  if (
    t.isLogicalExpression(rawExpression) &&
    t.isLogicalExpression(expression)
  ) {
    return (
      isSidecarSafeCssRuleBranch(rawExpression.left, state) &&
      isSidecarSafeCssRuleBranch(rawExpression.right, state)
    );
  }

  if (
    (t.isCallExpression(rawExpression) ||
      t.isOptionalCallExpression(rawExpression)) &&
    (t.isCallExpression(expression) || t.isOptionalCallExpression(expression))
  ) {
    return isSidecarSafeExpression(rawExpression, state);
  }

  return true;
}

function isSidecarSafeCssRuleBranch(
  expression: t.Expression,
  state: SidecarSafetyState
): boolean {
  return (
    !hasSidecarBranch(expression, state.scope) ||
    isSidecarSafeCssRuleExpression({ expression, state })
  );
}

function isSidecarSafeExpression(
  expression: t.Expression | t.Super,
  state: SidecarSafetyState
): boolean {
  const unwrappedExpression = t.isSuper(expression)
    ? expression
    : unwrapTransparentCssRuleExpression(expression);

  if (t.isIdentifier(unwrappedExpression)) {
    return isSidecarSafeIdentifier(unwrappedExpression, state);
  }

  if (
    t.isThisExpression(unwrappedExpression) ||
    t.isSuper(unwrappedExpression)
  ) {
    return false;
  }

  if (isSidecarSafeLiteral(unwrappedExpression)) {
    return true;
  }

  if (
    t.isMemberExpression(unwrappedExpression) ||
    t.isOptionalMemberExpression(unwrappedExpression)
  ) {
    return (
      isSidecarSafeExpression(unwrappedExpression.object, state) &&
      (!unwrappedExpression.computed ||
        (t.isExpression(unwrappedExpression.property) &&
          isSidecarSafeExpression(unwrappedExpression.property, state)))
    );
  }

  if (
    t.isCallExpression(unwrappedExpression) ||
    t.isOptionalCallExpression(unwrappedExpression)
  ) {
    return (
      t.isExpression(unwrappedExpression.callee) &&
      isSidecarSafeExpression(unwrappedExpression.callee, state) &&
      unwrappedExpression.arguments.every((argument) =>
        t.isSpreadElement(argument)
          ? isSidecarSafeExpression(argument.argument, state)
          : t.isExpression(argument) && isSidecarSafeExpression(argument, state)
      )
    );
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    return isSidecarSafeObjectExpression(unwrappedExpression, state);
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return unwrappedExpression.elements.every((element) => {
      if (!element) {
        return false;
      }

      return t.isSpreadElement(element)
        ? isSidecarSafeExpression(element.argument, state)
        : isSidecarSafeExpression(element, state);
    });
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      isSidecarSafeExpression(unwrappedExpression.test, state) &&
      isSidecarSafeExpression(unwrappedExpression.consequent, state) &&
      isSidecarSafeExpression(unwrappedExpression.alternate, state)
    );
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return (
      isSidecarSafeExpression(unwrappedExpression.left, state) &&
      isSidecarSafeExpression(unwrappedExpression.right, state)
    );
  }

  if (t.isUnaryExpression(unwrappedExpression)) {
    return isSidecarSafeExpression(unwrappedExpression.argument, state);
  }

  if (t.isTemplateLiteral(unwrappedExpression)) {
    return unwrappedExpression.expressions.every(
      (item) => t.isExpression(item) && isSidecarSafeExpression(item, state)
    );
  }

  if (
    t.isFunctionExpression(unwrappedExpression) ||
    t.isArrowFunctionExpression(unwrappedExpression)
  ) {
    return isSidecarSafeFunctionLike(
      unwrappedExpression,
      state,
      isSidecarSafeExpression
    );
  }

  return false;
}

function isSidecarSafeObjectExpression(
  expression: t.ObjectExpression,
  state: SidecarSafetyState
): boolean {
  return expression.properties.every((property) => {
    if (t.isSpreadElement(property)) {
      return isSidecarSafeExpression(property.argument, state);
    }

    if (t.isObjectMethod(property)) {
      return isSidecarSafeFunctionLike(
        property,
        state,
        isSidecarSafeExpression
      );
    }

    if (!t.isObjectProperty(property) || !t.isExpression(property.value)) {
      return false;
    }

    return (
      (!property.computed ||
        (t.isExpression(property.key) &&
          isSidecarSafeExpression(property.key, state))) &&
      isSidecarSafeExpression(property.value, state)
    );
  });
}

function isSidecarSafeArrayExpression(
  expression: t.ArrayExpression,
  state: SidecarSafetyState
): boolean {
  return expression.elements.every((element) => {
    if (!element) {
      return false;
    }

    return t.isSpreadElement(element)
      ? isSidecarSafeExpression(element.argument, state)
      : isSidecarSafeExpression(element, state);
  });
}

function isSidecarSafeIdentifier(
  identifier: t.Identifier,
  state: SidecarSafetyState
): boolean {
  if (state.localNames.has(identifier.name)) {
    return true;
  }

  const binding = state.scope.getBinding(identifier.name);

  if (!binding) {
    return buildTimeSafeGlobalNames.has(identifier.name);
  }

  return isSidecarSafeBinding(binding, state);
}

function isSidecarSafeBinding(
  binding: SidecarBinding,
  state: SidecarSafetyState
): boolean {
  if (state.visiting.has(binding)) {
    return true;
  }

  if (
    binding.path.isImportSpecifier() ||
    binding.path.isImportDefaultSpecifier() ||
    binding.path.isImportNamespaceSpecifier()
  ) {
    return true;
  }

  const visiting = new Set(state.visiting).add(binding);
  const nextState = { ...state, visiting };

  if (binding.path.isFunctionDeclaration()) {
    return isSidecarSafeFunctionLike(
      binding.path.node,
      nextState,
      isSidecarSafeExpression
    );
  }

  if (binding.path.isVariableDeclarator()) {
    const declaration = binding.path.parentPath;

    return (
      declaration.isVariableDeclaration({ kind: "const" }) &&
      binding.constant &&
      Boolean(binding.path.node.init) &&
      t.isExpression(binding.path.node.init) &&
      isSidecarSafeExpression(binding.path.node.init, nextState)
    );
  }

  return false;
}
