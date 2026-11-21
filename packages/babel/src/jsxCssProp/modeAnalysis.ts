import type { ReplayAnalysis } from "../extractionCalls/replayAnalysis.js";
import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import {
  containsArraySpreadElement,
  isDirectCssRuleLiteralExpression
} from "./classification.js";
import { isSidecarSafeCssRuleExpression } from "./sidecarSafety.js";
import {
  getSidecarCssRuleClassification,
  hasSidecarBranch
} from "./sidecarShape.js";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
import type { CssPropSidecarHoistability } from "./types.js";

type AnalysisScope = NodePath<t.JSXOpeningElement>["scope"];

type AnalysisBinding = NonNullable<ReturnType<AnalysisScope["getBinding"]>>;

// Internal evidence belongs to this exact analysis result. Keep the public
// classification shape stable, and do not reuse it across AST transformations.
const unprovenBindingResults = new WeakSet<CssPropSidecarHoistability>();
export function hasUnprovenSidecarBinding(
  result: CssPropSidecarHoistability
): boolean {
  return unprovenBindingResults.has(result);
}

export function analyzeCssPropSidecarHoistability(options: {
  readonly expression: t.Expression;
  readonly path?: NodePath<t.Expression>;
  readonly reducedExpression?: t.Expression;
  readonly scope: AnalysisScope;
  readonly analysis?: ReplayAnalysis;
  readonly unmodifiedBindings?: ReadonlySet<AnalysisBinding>;
}): CssPropSidecarHoistability {
  const reducedExpression = options.reducedExpression ?? options.expression;
  const reducedCssValueClassification = getSidecarCssRuleClassification(
    reducedExpression,
    options.scope
  );

  const rawCssValueClassification = getSidecarCssRuleClassification(
    options.expression,
    options.scope
  );

  const preservedRawArraySpreadClassification =
    getPreservedRawArraySpreadCssRuleClassification({
      expression: options.expression,
      reducedExpression,
      scope: options.scope
    });

  if (
    reducedCssValueClassification &&
    !rawCssValueClassification &&
    isKnownPrimitiveSidecarCallAlias(reducedExpression, options.scope)
  ) {
    return { kind: "not-candidate" };
  }

  const cssValueClassification =
    reducedCssValueClassification ??
    rawCssValueClassification ??
    preservedRawArraySpreadClassification;

  if (!cssValueClassification) {
    return { kind: "not-candidate" };
  }

  let unprovenBinding = false;
  const safe = isSidecarSafeCssRuleExpression({
    expression: reducedCssValueClassification
      ? reducedExpression
      : options.expression,
    rawExpression: options.expression,
    path: options.path,
    state: {
      scope: options.scope,
      analysis: options.analysis,
      onUnprovenBinding: () => {
        unprovenBinding = true;
      },
      unmodifiedBindings: options.unmodifiedBindings,
      visiting: new Set(),
      localNames: new Set()
    }
  });

  if (safe) return { kind: "hoistable", cssValueClassification };
  const result = { kind: "unsafe" } as const;
  if (unprovenBinding) unprovenBindingResults.add(result);
  return result;
}

function getPreservedRawArraySpreadCssRuleClassification(options: {
  readonly expression: t.Expression;
  readonly reducedExpression: t.Expression;
  readonly scope: AnalysisScope;
}): "css-rule" | null {
  const expression = unwrapTransparentCssRuleExpression(options.expression);
  const reducedExpression = unwrapTransparentCssRuleExpression(
    options.reducedExpression
  );

  return t.isArrayExpression(expression) &&
    containsArraySpreadElement(expression) &&
    !containsImportedTopLevelArrayReference(expression, options.scope) &&
    t.isArrayExpression(reducedExpression) &&
    containsObjectArrayElement(reducedExpression) &&
    isDirectCssRuleLiteralExpression(reducedExpression)
    ? "css-rule"
    : null;
}

function containsObjectArrayElement(expression: t.ArrayExpression): boolean {
  return expression.elements.some((element) => {
    if (!element || t.isSpreadElement(element)) {
      return false;
    }

    const unwrappedElement = unwrapTransparentCssRuleExpression(element);

    if (t.isObjectExpression(unwrappedElement)) {
      return true;
    }

    return t.isArrayExpression(unwrappedElement)
      ? containsObjectArrayElement(unwrappedElement)
      : false;
  });
}

export function containsImportedTopLevelArrayReference(
  expression: t.ArrayExpression,
  scope: AnalysisScope
): boolean {
  return expression.elements.some((element) => {
    if (!element) {
      return false;
    }

    const candidate = t.isSpreadElement(element) ? element.argument : element;
    const unwrappedCandidate = t.isExpression(candidate)
      ? unwrapTransparentCssRuleExpression(candidate)
      : candidate;

    if (t.isArrayExpression(unwrappedCandidate)) {
      return containsImportedTopLevelArrayReference(unwrappedCandidate, scope);
    }

    if (!t.isIdentifier(unwrappedCandidate)) {
      return false;
    }

    const binding = scope.getBinding(unwrappedCandidate.name);

    return Boolean(
      binding?.path.isImportSpecifier() ||
      binding?.path.isImportDefaultSpecifier() ||
      binding?.path.isImportNamespaceSpecifier()
    );
  });
}

function isKnownPrimitiveSidecarCallAlias(
  expression: t.Expression,
  scope: AnalysisScope
): boolean {
  if (!t.isCallExpression(expression) || !t.isIdentifier(expression.callee)) {
    return false;
  }

  const binding = scope.getBinding(expression.callee.name);

  return Boolean(
    (binding?.path.isFunctionDeclaration() &&
      functionReturnsOnlyStaticPrimitive(binding.path.node)) ||
    isMinchoCssClassValueCallBinding(binding?.path)
  );
}

function isMinchoCssClassValueCallBinding(
  path: AnalysisBinding["path"] | undefined
): boolean {
  if (!path?.isImportSpecifier()) {
    return false;
  }

  const declaration = path.parentPath;

  return (
    declaration.isImportDeclaration() &&
    declaration.node.source.value === "@mincho-js/css" &&
    t.isIdentifier(path.node.imported) &&
    (path.node.imported.name === "css" || path.node.imported.name === "cx")
  );
}

export function functionReturnsOnlyStaticPrimitive(node: t.Function): boolean {
  if (!t.isBlockStatement(node.body)) {
    return isStaticPrimitiveExpression(node.body);
  }

  const returns: t.ReturnStatement[] = [];

  for (const statement of node.body.body) {
    collectReturnStatements(statement, returns);
  }

  return (
    returns.length > 0 &&
    returns.every((statement) => {
      return Boolean(
        statement.argument && isStaticPrimitiveExpression(statement.argument)
      );
    })
  );
}

function collectReturnStatements(
  statement: t.Statement,
  returns: t.ReturnStatement[]
): void {
  if (t.isReturnStatement(statement)) {
    returns.push(statement);

    return;
  }

  if (t.isFunctionDeclaration(statement)) {
    return;
  }

  if (t.isBlockStatement(statement)) {
    for (const child of statement.body) {
      collectReturnStatements(child, returns);
    }

    return;
  }

  if (t.isIfStatement(statement)) {
    collectReturnStatements(statement.consequent, returns);

    if (statement.alternate)
      collectReturnStatements(statement.alternate, returns);

    return;
  }

  if (t.isTryStatement(statement)) {
    collectReturnStatements(statement.block, returns);

    if (statement.handler)
      collectReturnStatements(statement.handler.body, returns);
    if (statement.finalizer)
      collectReturnStatements(statement.finalizer, returns);

    return;
  }

  if (t.isSwitchStatement(statement)) {
    for (const switchCase of statement.cases) {
      for (const child of switchCase.consequent) {
        collectReturnStatements(child, returns);
      }
    }

    return;
  }

  if (
    t.isWhileStatement(statement) ||
    t.isDoWhileStatement(statement) ||
    t.isForStatement(statement) ||
    t.isForInStatement(statement) ||
    t.isForOfStatement(statement) ||
    t.isLabeledStatement(statement) ||
    t.isWithStatement(statement)
  ) {
    collectReturnStatements(statement.body, returns);
  }
}

function isStaticPrimitiveExpression(expression: t.Expression): boolean {
  return (
    t.isStringLiteral(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBooleanLiteral(expression) ||
    t.isNullLiteral(expression) ||
    (t.isTemplateLiteral(expression) && expression.expressions.length === 0)
  );
}

export { getSidecarCssRuleClassification, hasSidecarBranch };
