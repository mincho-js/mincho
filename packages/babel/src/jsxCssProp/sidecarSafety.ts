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
  readonly state: SidecarSafetyState;
}): boolean {
  const expression = unwrapTransparentCssRuleExpression(options.expression);

  if (isSidecarRuleCallExpression(expression, options.state.scope)) {
    return (
      t.isExpression(expression.callee) &&
      isSidecarSafeExpression(expression.callee, options.state) &&
      expression.arguments.every((argument) =>
        t.isSpreadElement(argument)
          ? isSidecarSafeExpression(argument.argument, options.state)
          : t.isExpression(argument) &&
            isSidecarSafeExpression(argument, options.state)
      )
    );
  }

  if (t.isObjectExpression(expression)) {
    return expression.properties.every((property) => {
      if (t.isSpreadElement(property)) {
        return isSidecarSafeExpression(property.argument, options.state);
      }

      if (t.isObjectMethod(property)) {
        return isSidecarSafeFunctionLike(
          property,
          options.state,
          isSidecarSafeExpression
        );
      }

      if (!t.isObjectProperty(property) || !t.isExpression(property.value)) {
        return false;
      }

      if (
        property.computed &&
        (!t.isExpression(property.key) ||
          !isSidecarSafeExpression(property.key, options.state))
      ) {
        return false;
      }

      return isSidecarSafeExpression(property.value, options.state);
    });
  }

  if (t.isArrayExpression(expression)) {
    return expression.elements.every((element) => {
      if (!element) {
        return false;
      }

      if (t.isSpreadElement(element)) {
        return isSidecarSafeExpression(element.argument, options.state);
      }

      return isSidecarSafeExpression(element, options.state);
    });
  }

  if (t.isConditionalExpression(expression)) {
    return (
      isSidecarSafeCssRuleBranch(expression.consequent, options.state) &&
      isSidecarSafeCssRuleBranch(expression.alternate, options.state)
    );
  }

  if (t.isLogicalExpression(expression)) {
    return (
      isSidecarSafeCssRuleBranch(expression.left, options.state) &&
      isSidecarSafeCssRuleBranch(expression.right, options.state)
    );
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
