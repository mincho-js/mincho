import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { Binding, Scope } from "@babel/traverse";
import {
  getStaticMemberPropertyName,
  getStaticObjectMemberValue,
  getUnsupportedLiteralReason
} from "./ast.js";
import {
  getStaticCssEvalMemberReference,
  unwrapTransparentCssRuleExpression
} from "./candidates.js";
import type { StaticMemberReference } from "./candidates.js";
import { createStaticCssEvalDiagnostic } from "./diagnostics.js";
import {
  enforceStaticCssEvalLiteralNodeCount,
  enforceStaticCssEvalObjectArrayRecursionDepth
} from "./limits.js";
import type {
  StaticCssEvalDiagnostic,
  StaticCssEvalSourceLocation,
  StaticCssEvalUnsupportedReason
} from "./types.js";

export type SameFileStaticCssEvalResult =
  | { kind: "not-candidate" }
  | {
      kind: "resolved";
      expression: t.ObjectExpression | t.ArrayExpression;
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
    };

export interface ResolveSameFileStaticCssEvalOptions {
  expression: t.Expression;
  ownerFile: string;
  programPath: NodePath<t.Program>;
  scope: Scope;
}

interface SameFileStaticCssEvalContext {
  binding: Binding;
  bindingName: string;
  memberPath: string[];
  owner: StaticCssEvalSourceLocation;
}

interface LiteralValidationState {
  count: number;
}

const arrayMutationMethods = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift"
]);

const objectMutationMethods = new Set([
  "assign",
  "defineProperties",
  "defineProperty",
  "setPrototypeOf"
]);

export function resolveSameFileStaticCssEvalExpression(
  options: ResolveSameFileStaticCssEvalOptions
): SameFileStaticCssEvalResult {
  const reference = getStaticCssEvalMemberReference(options.expression);
  const expressionRange = getExpressionRange(
    unwrapTransparentCssRuleExpression(options.expression)
  );

  if (!reference || !expressionRange) {
    return { kind: "not-candidate" };
  }

  const binding = options.scope.getBinding(reference.bindingName);

  if (!binding) {
    return { kind: "not-candidate" };
  }

  const init = getStaticCssEvalConstBindingInitExpression(binding);

  if (!init) {
    return { kind: "not-candidate" };
  }

  const memberPath = reference.memberPath;
  const context: SameFileStaticCssEvalContext = {
    binding,
    bindingName: reference.bindingName,
    memberPath,
    owner: {
      file: options.ownerFile,
      start: expressionRange.start,
      end: expressionRange.end
    }
  };

  if (reference.kind === "unsupported") {
    const unsupportedMemberPathDiagnostic =
      createUnsupportedMemberPathDiagnostic(init, reference, context);

    if (!unsupportedMemberPathDiagnostic) {
      return { kind: "not-candidate" };
    }

    if (hasStaticCssEvalBindingMutation(options.programPath, binding)) {
      return {
        kind: "error",
        diagnostic: createSameFileStaticCssEvalDiagnostic(
          context,
          "mutation-detected",
          "mutated-binding",
          `same-file binding "${reference.bindingName}" is mutated`
        )
      };
    }

    return {
      kind: "error",
      diagnostic: unsupportedMemberPathDiagnostic
    };
  }

  const resolvedExpression = resolveStaticMemberPath(init, memberPath);

  if (!resolvedExpression || !isStaticCssRuleLiteral(resolvedExpression)) {
    return { kind: "not-candidate" };
  }

  if (hasStaticCssEvalBindingMutation(options.programPath, binding)) {
    return {
      kind: "error",
      diagnostic: createSameFileStaticCssEvalDiagnostic(
        context,
        "mutation-detected",
        "mutated-binding",
        `same-file binding "${reference.bindingName}" is mutated`
      )
    };
  }

  const validationDiagnostic = validateStaticCssLiteralExpression(
    resolvedExpression,
    context,
    { count: 0 },
    1
  );

  if (validationDiagnostic) {
    return { kind: "error", diagnostic: validationDiagnostic };
  }

  return {
    kind: "resolved",
    expression: normalizeStaticCssLiteralExpression(resolvedExpression)
  };
}

function getExpressionRange(
  expression: t.Expression
): { start: number; end: number } | null {
  const { start, end } = expression;

  if (typeof start !== "number" || typeof end !== "number") {
    return null;
  }

  return { start, end };
}

export function getStaticCssEvalConstBindingInitExpression(
  binding: Binding
): t.Expression | null {
  const bindingPath = binding.path;

  if (!bindingPath.isVariableDeclarator()) {
    return null;
  }

  if (!t.isIdentifier(bindingPath.node.id)) {
    return null;
  }

  if (!bindingPath.parentPath.isVariableDeclaration({ kind: "const" })) {
    return null;
  }

  const initPath = bindingPath.get("init");

  if (!initPath.node || !initPath.isExpression()) {
    return null;
  }

  return initPath.node;
}

function resolveStaticMemberPath(
  expression: t.Expression,
  memberPath: readonly string[]
): t.Expression | null {
  let currentExpression: t.Expression | null =
    unwrapTransparentCssRuleExpression(expression);

  for (const memberName of memberPath) {
    if (!currentExpression) {
      return null;
    }

    const unwrappedExpression =
      unwrapTransparentCssRuleExpression(currentExpression);

    if (t.isObjectExpression(unwrappedExpression)) {
      currentExpression = getStaticObjectMemberValue(
        unwrappedExpression,
        memberName
      );
      continue;
    }

    return null;
  }

  return currentExpression
    ? unwrapTransparentCssRuleExpression(currentExpression)
    : null;
}

function getStaticArrayMemberValue(
  expression: t.ArrayExpression,
  memberName: string
): t.Expression | null {
  if (!/^\d+$/.test(memberName)) {
    return null;
  }

  const element = expression.elements[Number(memberName)];

  return element && t.isExpression(element) ? element : null;
}

function isStaticCssRuleLiteral(
  expression: t.Expression
): expression is t.ObjectExpression | t.ArrayExpression {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);
  return (
    t.isObjectExpression(unwrappedExpression) ||
    t.isArrayExpression(unwrappedExpression)
  );
}

function createUnsupportedMemberPathDiagnostic(
  expression: t.Expression,
  reference: Extract<StaticMemberReference, { kind: "unsupported" }>,
  context: SameFileStaticCssEvalContext
): StaticCssEvalDiagnostic | null {
  const baseExpression = resolveStaticMemberPath(
    expression,
    reference.memberPath
  );

  if (
    !baseExpression ||
    !isProvenStaticCssRuleMemberTarget(
      baseExpression,
      reference.unsupportedPropertyName
    )
  ) {
    return null;
  }

  return createSameFileStaticCssEvalDiagnostic(
    context,
    "unsupported-syntax",
    reference.reason,
    `same-file binding "${context.bindingName}" contains unsupported ${reference.reason}: ${reference.detail}`
  );
}

function isProvenStaticCssRuleMemberTarget(
  expression: t.Expression,
  unsupportedPropertyName?: string
): boolean {
  if (unsupportedPropertyName !== undefined) {
    const value = getStaticMemberValueForUnsupportedProperty(
      expression,
      unsupportedPropertyName
    );

    return Boolean(value && isStaticCssRuleLiteral(value));
  }

  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isObjectExpression(unwrappedExpression)) {
    return hasOnlyStaticCssRuleObjectValues(unwrappedExpression);
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return hasOnlyStaticCssRuleArrayValues(unwrappedExpression);
  }

  return false;
}

function getStaticMemberValueForUnsupportedProperty(
  expression: t.Expression,
  memberName: string
): t.Expression | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isObjectExpression(unwrappedExpression)) {
    return getStaticObjectMemberValue(unwrappedExpression, memberName);
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return getStaticArrayMemberValue(unwrappedExpression, memberName);
  }

  return null;
}

function hasOnlyStaticCssRuleObjectValues(
  expression: t.ObjectExpression
): boolean {
  if (expression.properties.length === 0) {
    return false;
  }

  return expression.properties.every((property) => {
    if (!t.isObjectProperty(property) || property.computed) {
      return false;
    }

    return (
      t.isExpression(property.value) && isStaticCssRuleLiteral(property.value)
    );
  });
}

function hasOnlyStaticCssRuleArrayValues(
  expression: t.ArrayExpression
): boolean {
  if (expression.elements.length === 0) {
    return false;
  }

  return expression.elements.every((element) => {
    return Boolean(
      element && !t.isSpreadElement(element) && isStaticCssRuleLiteral(element)
    );
  });
}

export function hasStaticCssEvalBindingMutation(
  programPath: NodePath<t.Program>,
  binding: Binding
): boolean {
  if (binding.constantViolations.length > 0) {
    return true;
  }

  let mutated = false;

  programPath.traverse({
    AssignmentExpression(path) {
      if (pathTouchesBinding(path.get("left"), binding)) {
        mutated = true;
        path.stop();
      }
    },
    CallExpression(path) {
      if (isMutatingCallExpression(path, binding)) {
        mutated = true;
        path.stop();
      }
    },
    UnaryExpression(path) {
      if (
        path.node.operator === "delete" &&
        pathTouchesBinding(path.get("argument"), binding)
      ) {
        mutated = true;
        path.stop();
      }
    },
    UpdateExpression(path) {
      if (pathTouchesBinding(path.get("argument"), binding)) {
        mutated = true;
        path.stop();
      }
    }
  });

  return mutated;
}

function isMutatingCallExpression(
  path: NodePath<t.CallExpression>,
  binding: Binding
): boolean {
  const calleePath = path.get("callee");

  if (calleePath.isMemberExpression()) {
    const methodName = getStaticMemberPropertyName(calleePath.node);

    if (
      methodName &&
      arrayMutationMethods.has(methodName) &&
      pathTouchesBinding(calleePath.get("object"), binding)
    ) {
      return true;
    }

    if (isObjectMutationCall(calleePath, methodName)) {
      const firstArgument = path.get("arguments.0");
      return Boolean(
        firstArgument?.node && pathTouchesBinding(firstArgument, binding)
      );
    }
  }

  return false;
}

function isObjectMutationCall(
  calleePath: NodePath<t.MemberExpression>,
  methodName: string | null
): boolean {
  if (!methodName || !objectMutationMethods.has(methodName)) {
    return false;
  }

  const objectPath = calleePath.get("object");
  return objectPath.isIdentifier({ name: "Object" });
}

function pathTouchesBinding(
  path: NodePath<t.Node | null>,
  binding: Binding
): boolean {
  if (!path.node) {
    return false;
  }

  if (path.isIdentifier()) {
    return path.scope.getBinding(path.node.name) === binding;
  }

  if (path.isMemberExpression()) {
    return pathTouchesBinding(path.get("object") as NodePath<t.Node>, binding);
  }

  if (path.isArrayPattern()) {
    return path.get("elements").some((elementPath) => {
      return Boolean(
        elementPath.node &&
        pathTouchesBinding(elementPath as NodePath<t.Node>, binding)
      );
    });
  }

  if (path.isObjectPattern()) {
    return path.get("properties").some((propertyPath) => {
      if (propertyPath.isObjectProperty()) {
        return pathTouchesBinding(propertyPath.get("value"), binding);
      }

      if (propertyPath.isRestElement()) {
        return pathTouchesBinding(propertyPath.get("argument"), binding);
      }

      return false;
    });
  }

  if (path.isRestElement()) {
    return pathTouchesBinding(
      path.get("argument") as NodePath<t.Node>,
      binding
    );
  }

  if (path.isTSNonNullExpression()) {
    return pathTouchesBinding(
      path.get("expression") as NodePath<t.Node>,
      binding
    );
  }

  if (path.isTSAsExpression()) {
    return pathTouchesBinding(
      path.get("expression") as NodePath<t.Node>,
      binding
    );
  }

  if (path.isTSSatisfiesExpression()) {
    return pathTouchesBinding(
      path.get("expression") as NodePath<t.Node>,
      binding
    );
  }

  if (path.isParenthesizedExpression()) {
    return pathTouchesBinding(
      path.get("expression") as NodePath<t.Node>,
      binding
    );
  }

  return false;
}

function validateStaticCssLiteralExpression(
  expression: t.Expression,
  context: SameFileStaticCssEvalContext,
  state: LiteralValidationState,
  depth: number
): StaticCssEvalDiagnostic | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);
  state.count += 1;

  const countResult = enforceStaticCssEvalLiteralNodeCount({
    owner: context.owner,
    memberPath: context.memberPath,
    literalNodeCount: state.count
  });

  if (!countResult.ok) {
    return countResult.diagnostic;
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    const depthResult = enforceStaticCssEvalObjectArrayRecursionDepth({
      owner: context.owner,
      memberPath: context.memberPath,
      recursionDepth: depth
    });

    if (!depthResult.ok) {
      return depthResult.diagnostic;
    }

    return validateStaticCssObjectExpression(
      unwrappedExpression,
      context,
      state,
      depth
    );
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    const depthResult = enforceStaticCssEvalObjectArrayRecursionDepth({
      owner: context.owner,
      memberPath: context.memberPath,
      recursionDepth: depth
    });

    if (!depthResult.ok) {
      return depthResult.diagnostic;
    }

    return validateStaticCssArrayExpression(
      unwrappedExpression,
      context,
      state,
      depth
    );
  }

  if (isSupportedStaticCssPrimitiveLiteral(unwrappedExpression)) {
    return null;
  }

  return createUnsupportedLiteralDiagnostic(context, unwrappedExpression);
}

function validateStaticCssObjectExpression(
  expression: t.ObjectExpression,
  context: SameFileStaticCssEvalContext,
  state: LiteralValidationState,
  depth: number
): StaticCssEvalDiagnostic | null {
  for (const property of expression.properties) {
    if (t.isSpreadElement(property)) {
      return createSameFileStaticCssEvalDiagnostic(
        context,
        "unsupported-syntax",
        "object-or-array-spread",
        `same-file binding "${context.bindingName}" contains an object spread`
      );
    }

    if (!t.isObjectProperty(property)) {
      return createSameFileStaticCssEvalDiagnostic(
        context,
        "unsupported-syntax",
        "function-or-call",
        `same-file binding "${context.bindingName}" contains an object method`
      );
    }

    if (property.computed) {
      return createSameFileStaticCssEvalDiagnostic(
        context,
        "unsupported-syntax",
        "computed-object-key",
        `same-file binding "${context.bindingName}" contains a computed object key`
      );
    }

    if (!t.isExpression(property.value)) {
      return createSameFileStaticCssEvalDiagnostic(
        context,
        "unsupported-syntax",
        "unsupported-literal",
        `same-file binding "${context.bindingName}" contains a non-expression object value`
      );
    }

    const diagnostic = validateStaticCssLiteralExpression(
      property.value,
      context,
      state,
      depth + 1
    );

    if (diagnostic) {
      return diagnostic;
    }
  }

  return null;
}

function validateStaticCssArrayExpression(
  expression: t.ArrayExpression,
  context: SameFileStaticCssEvalContext,
  state: LiteralValidationState,
  depth: number
): StaticCssEvalDiagnostic | null {
  for (const element of expression.elements) {
    if (!element) {
      return createSameFileStaticCssEvalDiagnostic(
        context,
        "unsupported-syntax",
        "unsupported-literal",
        `same-file binding "${context.bindingName}" contains an array hole`
      );
    }

    if (t.isSpreadElement(element)) {
      return createSameFileStaticCssEvalDiagnostic(
        context,
        "unsupported-syntax",
        "object-or-array-spread",
        `same-file binding "${context.bindingName}" contains an array spread`
      );
    }

    const diagnostic = validateStaticCssLiteralExpression(
      element,
      context,
      state,
      depth + 1
    );

    if (diagnostic) {
      return diagnostic;
    }
  }

  return null;
}

function isSupportedStaticCssPrimitiveLiteral(
  expression: t.Expression
): boolean {
  return (
    t.isStringLiteral(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBooleanLiteral(expression) ||
    t.isNullLiteral(expression) ||
    isUnaryNumericLiteral(expression) ||
    isNoExpressionTemplateLiteral(expression)
  );
}

function isUnaryNumericLiteral(
  expression: t.Expression
): expression is t.UnaryExpression & { argument: t.NumericLiteral } {
  return (
    t.isUnaryExpression(expression) &&
    (expression.operator === "+" || expression.operator === "-") &&
    t.isNumericLiteral(expression.argument)
  );
}

function isNoExpressionTemplateLiteral(
  expression: t.Expression
): expression is t.TemplateLiteral {
  return t.isTemplateLiteral(expression) && expression.expressions.length === 0;
}

function normalizeStaticCssLiteralExpression(
  expression: t.ObjectExpression | t.ArrayExpression
): t.ObjectExpression | t.ArrayExpression {
  const normalizedExpression = normalizeStaticCssLiteralValue(expression);

  if (
    !t.isObjectExpression(normalizedExpression) &&
    !t.isArrayExpression(normalizedExpression)
  ) {
    throw new Error(
      "Expected normalized static css literal to remain object/array"
    );
  }

  return normalizedExpression;
}

function normalizeStaticCssLiteralValue(
  expression: t.Expression
): t.Expression {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isObjectExpression(unwrappedExpression)) {
    return t.objectExpression(
      unwrappedExpression.properties.map((property) => {
        const nextProperty = t.cloneNode(property);

        if (
          t.isObjectProperty(nextProperty) &&
          t.isExpression(nextProperty.value)
        ) {
          nextProperty.value = normalizeStaticCssLiteralValue(
            nextProperty.value
          );
        }

        return nextProperty;
      })
    );
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return t.arrayExpression(
      unwrappedExpression.elements.map((element) => {
        if (!element || t.isSpreadElement(element)) {
          return element ? t.cloneNode(element) : null;
        }

        return normalizeStaticCssLiteralValue(element);
      })
    );
  }

  if (isNoExpressionTemplateLiteral(unwrappedExpression)) {
    const [quasi] = unwrappedExpression.quasis;
    return t.stringLiteral(quasi?.value.cooked ?? quasi?.value.raw ?? "");
  }

  return t.cloneNode(unwrappedExpression);
}

function createUnsupportedLiteralDiagnostic(
  context: SameFileStaticCssEvalContext,
  expression: t.Expression
): StaticCssEvalDiagnostic {
  const reason = getUnsupportedLiteralReason(expression);

  return createSameFileStaticCssEvalDiagnostic(
    context,
    "unsupported-syntax",
    reason,
    `same-file binding "${context.bindingName}" contains unsupported ${reason}: ${expression.type}`
  );
}

function createSameFileStaticCssEvalDiagnostic(
  context: SameFileStaticCssEvalContext,
  code: StaticCssEvalDiagnostic["code"],
  reason: StaticCssEvalUnsupportedReason,
  detail: string
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    code,
    reason,
    detail,
    owner: context.owner,
    ...(context.memberPath.length > 0 ? { memberPath: context.memberPath } : {})
  });
}
