import { types as t } from "@babel/core";
import type { Binding } from "@babel/traverse";
import { analyzeStaticCssEvalBindingMutation } from "../sameFile/mutation.js";
import { getStaticCssEvalBindingDeclarationKind } from "../sameFile/shapes.js";
import type { PartialEvalBindingFrame } from "./context.js";
import {
  getDestructuredBindingSource,
  resolveStaticMemberPath,
  type PartialEvalBindingSource
} from "./destructuring.js";
import type { PartialEvalDeoptPath, PartialEvalResult } from "./result.js";
import type { PartialEvalReducerNodeOptions } from "./reduction.js";

export function reduceIdentifierExpression(
  options: PartialEvalReducerNodeOptions<t.Identifier>
): PartialEvalResult {
  if (
    !options.reductionContext.scope ||
    !options.reductionContext.programPath
  ) {
    return options.runtime.createDeoptResult({
      expression: options.expression,
      reason: "runtime-css-shape"
    });
  }

  const binding = options.reductionContext.scope.getBinding(options.node.name);

  if (!binding) {
    return options.runtime.createDeoptResult({
      expression: options.expression,
      reason: "runtime-css-shape"
    });
  }

  const bindingDeoptPath: PartialEvalDeoptPath = [
    { kind: "binding", name: options.node.name }
  ];

  if (isImportedBinding(binding)) {
    return options.runtime.createDeoptResult({
      expression: options.expression,
      reason: "unsupported-import",
      details: {
        bindingName: options.node.name,
        deoptPath: bindingDeoptPath
      }
    });
  }

  const source = getPartialEvalBindingSource(
    binding,
    options.node.name,
    options.runtime.context.nativeArrayIteration
  );

  if (!source) {
    return createBindingShapeDeopt(options, bindingDeoptPath);
  }

  if (source.declarationKind === "let" || source.declarationKind === "var") {
    return options.runtime.createDeoptResult({
      expression: options.expression,
      reason: "runtime-css-shape",
      details: {
        bindingName: options.node.name,
        deoptPath: bindingDeoptPath,
        detail: `same-file binding "${options.node.name}" is not declared const`
      }
    });
  }

  if (source.declarationKind !== "const") {
    return createBindingShapeDeopt(options, bindingDeoptPath);
  }

  const currentFrame: PartialEvalBindingFrame = {
    bindingName: options.node.name,
    memberPath: source.memberPath,
    owner: options.runtime.context.owner
  };

  if (
    hasBindingStackCycle(options.reductionContext.bindingStack, currentFrame)
  ) {
    return options.runtime.createDeoptResult({
      expression: options.expression,
      reason: "cycle-detected",
      details: {
        bindingName: options.node.name,
        deoptPath: bindingDeoptPath
      }
    });
  }

  const nextBindingStack = [
    ...options.reductionContext.bindingStack,
    currentFrame
  ];

  if (
    nextBindingStack.length >
    options.runtime.context.limits.maxBindingStackDepth
  ) {
    return options.runtime.createDeoptResult({
      expression: options.expression,
      reason: "depth-limit",
      details: {
        bindingName: options.node.name,
        deoptPath: bindingDeoptPath
      }
    });
  }

  const sourceResult = options.runtime.reduceExpression({
    expression: source.init,
    depth: options.depth + 1,
    reductionContext: {
      ...options.reductionContext,
      bindingStack: nextBindingStack,
      scope: binding.scope
    }
  });

  // Structural mutation proofs fail closed for unresolved aliases too. Reduce
  // the initializer under the existing recursion/node budgets first so that
  // this uncertainty cannot hide a proven cycle or an exhausted budget. No
  // reduced value may escape without the same mutation check as before.
  const hardDeopt =
    sourceResult.kind === "deopt" &&
    (sourceResult.reason === "cycle-detected" ||
      sourceResult.reason === "depth-limit" ||
      sourceResult.reason === "node-count-limit");
  const mutation = analyzeStaticCssEvalBindingMutation(
    options.reductionContext.programPath,
    binding
  );
  if (
    !hardDeopt &&
    (mutation.kind === "may-mutate" ||
      (mutation.kind === "unknown" && sourceResult.kind === "confident"))
  ) {
    return createMutatedBindingDeopt(options, bindingDeoptPath);
  }
  // Unknown provenance cannot certify a value, but it also is not evidence of
  // mutation. Preserve a child's existing unsupported-shape diagnostic rather
  // than replacing it with a mutation diagnostic that hides its unsafe syntax.

  if (sourceResult.kind === "deopt") {
    return options.runtime.createDeoptFromChild({
      expression: options.expression,
      result: sourceResult,
      memberPath: source.memberPath,
      ...(source.memberPath.length === 0
        ? { fallbackExpression: sourceResult.fallbackExpression }
        : {})
    });
  }

  const resolvedExpression = resolveStaticMemberPath(
    sourceResult.expression,
    source.memberPath,
    source.arrayIterationOffsets
  );

  return resolvedExpression
    ? options.runtime.createConfidentResult(t.cloneNode(resolvedExpression))
    : createBindingShapeDeopt(options, [
        ...bindingDeoptPath,
        ...source.memberPath.map((name) => ({ kind: "member" as const, name }))
      ]);
}

function getPartialEvalBindingSource(
  binding: Binding,
  bindingName: string,
  nativeArrayIteration?: boolean
): PartialEvalBindingSource | null {
  const declarationKind = getStaticCssEvalBindingDeclarationKind(binding);

  if (declarationKind) {
    const bindingPath = binding.path;

    if (!bindingPath.isVariableDeclarator()) {
      return null;
    }

    const init = bindingPath.node.init;

    return init && t.isExpression(init)
      ? { declarationKind, init, memberPath: [] }
      : null;
  }

  return getDestructuredBindingSource(binding, bindingName, {
    nativeArrayIteration,
    deferArrayReceiverCheck: true
  });
}

function createBindingShapeDeopt(
  options: PartialEvalReducerNodeOptions<t.Identifier>,
  deoptPath: PartialEvalDeoptPath
): PartialEvalResult {
  return options.runtime.createDeoptResult({
    expression: options.expression,
    reason: "runtime-css-shape",
    details: { bindingName: options.node.name, deoptPath }
  });
}

function createMutatedBindingDeopt(
  options: PartialEvalReducerNodeOptions<t.Identifier>,
  deoptPath: PartialEvalDeoptPath
): PartialEvalResult {
  return options.runtime.createDeoptResult({
    expression: options.expression,
    reason: "mutated-binding",
    details: {
      bindingName: options.node.name,
      deoptPath,
      detail: `same-file binding "${options.node.name}" is mutated`
    }
  });
}

function isImportedBinding(binding: Binding): boolean {
  const bindingPath = binding.path;

  return (
    bindingPath.isImportSpecifier() ||
    bindingPath.isImportDefaultSpecifier() ||
    bindingPath.isImportNamespaceSpecifier()
  );
}

function hasBindingStackCycle(
  stack: readonly PartialEvalBindingFrame[],
  nextFrame: PartialEvalBindingFrame
): boolean {
  return stack.some((frame) => {
    return (
      frame.bindingName === nextFrame.bindingName &&
      areMemberPathsEqual(frame.memberPath, nextFrame.memberPath)
    );
  });
}

function areMemberPathsEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}
