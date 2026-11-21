import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
import { analyzeAliasedStaticCssEvalBindingMutation } from "../staticCssEval/sameFile/mutationAliases.js";
import {
  createReplayAnalysis,
  type ReplayAnalysis
} from "../extractionCalls/replayAnalysis.js";
import { mathBindingIdentityProof } from "../extractionCalls/mathResult.js";
import { patternSelectionEnvironment } from "./patternExpressions.js";
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
  readonly onUnprovenBinding?: () => void;
  readonly unmodifiedBindings?: ReadonlySet<SidecarBinding>;
  readonly visiting: ReadonlySet<SidecarBinding>;
  readonly localNames: ReadonlySet<string>;
  readonly analysis?: ReplayAnalysis;
};

export function isSidecarSafeCssRuleExpression(options: {
  readonly expression: t.Expression;
  readonly rawExpression?: t.Expression;
  readonly path?: NodePath<t.Expression>;
  readonly state: SidecarSafetyState;
}): boolean {
  const scope = options.path?.scope ?? options.state.scope;
  const state = {
    ...options.state,
    scope,
    analysis: options.state.analysis ?? createReplayAnalysis(scope)
  };
  const expression = unwrapTransparentCssRuleExpression(options.expression);
  const rawExpression = options.rawExpression
    ? unwrapTransparentCssRuleExpression(options.rawExpression)
    : null;

  if (
    rawExpression &&
    !isSidecarSafePreservedRawCssRuleExpression(
      rawExpression,
      expression,
      state
    )
  ) {
    return false;
  }

  return isSidecarSafeCssRuleExpressionNode(expression, state);
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
          ? isSidecarSafeIterableSpread(argument.argument, state)
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

  return isSidecarSafeExpression(expression, state);
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

  const executedBranches = t.isSuper(unwrappedExpression)
    ? undefined
    : t.isConditionalExpression(unwrappedExpression) ||
        t.isLogicalExpression(unwrappedExpression)
      ? state.analysis?.branches.branchesForNode(unwrappedExpression)
      : undefined;
  if (executedBranches)
    return executedBranches.every((branch) =>
      isSidecarSafeExpressionPath(branch, state)
    );

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
          ? isSidecarSafeIterableSpread(argument.argument, state)
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
        ? isSidecarSafeIterableSpread(element.argument, state)
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

/** Array/call spread replays iterator protocol even without any default. */
function isSidecarSafeIterableSpread(
  argument: t.Expression,
  state: SidecarSafetyState
): boolean {
  const program = state.scope.getProgramParent().path;
  if (!program.isProgram()) return false;
  return (
    patternSelectionEnvironment(program, state.analysis?.environment)
      .nativeArrayIteration && isSidecarSafeExpression(argument, state)
  );
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
      ? isSidecarSafeIterableSpread(element.argument, state)
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
    const initializer = binding.path.get("init");
    const program = binding.scope.getProgramParent().path;
    const analysis = state.analysis!;
    // A partial evaluator deopt is not permission to replay an unproven value.
    // Function bodies retain their separate capture/parameter safety analysis;
    // checking the function as data here would mistake its own calls for escapes.
    if (
      !initializer.isFunction() &&
      !state.unmodifiedBindings?.has(binding) &&
      !mathBindingIdentityProof(binding)
    ) {
      if (!program.isProgram()) return false;
      const mutation = analyzeAliasedStaticCssEvalBindingMutation(
        program,
        binding,
        {
          branchResult: analysis.branches.result,
          skippedPatternDefaults: analysis.skippedDefaults,
          callResultProof: analysis.jsxResult
        }
      );
      if (mutation.kind !== "proved-unmodified") {
        state.onUnprovenBinding?.();
        return false;
      }
    }

    return (
      declaration.isVariableDeclaration({ kind: "const" }) &&
      binding.constant &&
      Boolean(binding.path.node.init) &&
      t.isExpression(binding.path.node.init) &&
      analysis.everyPattern(
        binding.path.get("id"),
        (expression) => isSidecarSafeExpressionPath(expression, nextState),
        binding.path.node.init
      ) &&
      isSidecarSafeExpressionPath(binding.path.get("init"), nextState)
    );
  }

  return false;
}

function isSidecarSafeExpressionPath(
  path: NodePath<t.Node | null | undefined>,
  state: SidecarSafetyState
): boolean {
  if (!path.isExpression()) return false;
  if (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isTypeCastExpression() ||
    path.isParenthesizedExpression()
  )
    return isSidecarSafeExpressionPath(
      path.get("expression") as NodePath<t.Expression>,
      state
    );

  if (path.isBinaryExpression())
    return (
      isSidecarSafeExpressionPath(path.get("left"), state) &&
      isSidecarSafeExpressionPath(path.get("right"), state)
    );
  if (path.isSequenceExpression())
    return path
      .get("expressions")
      .every((item) => isSidecarSafeExpressionPath(item, state));
  return isSidecarSafeExpression(path.node, { ...state, scope: path.scope });
}
