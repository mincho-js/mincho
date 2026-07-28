import { types as t } from "@babel/core";
import {
  getStaticCssEvalMemberReference,
  unwrapTransparentCssRuleExpression
} from "../candidates.js";
import {
  createStaticCssEvalMutableBindingDiagnostic,
  guardStaticCssEvalResolutionDepth
} from "../diagnostics.js";
import {
  createSameFileContext,
  createSameFileDiagnosticContext,
  createSameFileLocalAliasCycleDiagnostic,
  createSameFileMetadata,
  findSameFileAliasCycleStartIndex,
  mergeSameFileMetadata,
  prependSameFileMetadata
} from "./metadata.js";
import {
  createSameFileStaticCssEvalDiagnostic,
  createUnsupportedMemberReferenceDiagnostic
} from "./diagnostics.js";
import type {
  SameFileBindingResolutionOptions,
  SameFileBindingResolutionResult,
  SameFileBindingStackFrame
} from "./types.js";
import { hasStaticCssEvalBindingMutation } from "./mutation.js";
import {
  getStaticCssEvalBindingDeclarationKind,
  getStaticCssEvalVariableBindingInitExpression,
  isProvenStaticCssRuleMemberTarget,
  isStaticCssRuleLiteral,
  resolveStaticMemberPath
} from "./shapes.js";

export function resolveSameFileBindingExpression(
  options: SameFileBindingResolutionOptions
): SameFileBindingResolutionResult {
  const declarationKind = getStaticCssEvalBindingDeclarationKind(
    options.binding
  );
  const init = getStaticCssEvalVariableBindingInitExpression(options.binding);

  if (!declarationKind || !init) {
    return { kind: "not-candidate" };
  }

  const context = createSameFileContext(options);
  const metadata = createSameFileMetadata(
    options.ownerFile,
    options.bindingName,
    options.memberPath,
    declarationKind
  );

  if (declarationKind === "let" || declarationKind === "var") {
    return isPotentialStaticCssEvalBindingInit(init, options.memberPath)
      ? {
          kind: "error",
          diagnostic: createStaticCssEvalMutableBindingDiagnostic(
            createSameFileDiagnosticContext(context),
            options.bindingName
          ),
          metadata
        }
      : { kind: "not-candidate" };
  }

  if (declarationKind !== "const") {
    return { kind: "not-candidate" };
  }

  const currentFrame: SameFileBindingStackFrame = {
    binding: options.binding,
    bindingName: options.bindingName,
    memberPath: [...options.memberPath]
  };
  const cycleStartIndex = findSameFileAliasCycleStartIndex(
    options.stack,
    currentFrame
  );

  if (cycleStartIndex !== -1) {
    return {
      kind: "error",
      diagnostic: createSameFileLocalAliasCycleDiagnostic(
        context,
        options.ownerFile,
        [...options.stack.slice(cycleStartIndex), currentFrame]
      ),
      metadata
    };
  }

  const nextStack = [...options.stack, currentFrame];
  const depthResult = guardStaticCssEvalResolutionDepth({
    owner: options.owner,
    dependency: { file: options.ownerFile },
    exportName: options.bindingName,
    memberPath: options.memberPath,
    resolutionDepth: nextStack.length
  });

  if (!depthResult.ok) {
    return {
      kind: "error",
      diagnostic: depthResult.diagnostic,
      metadata
    };
  }

  if (hasStaticCssEvalBindingMutation(options.programPath, options.binding)) {
    return {
      kind: "error",
      diagnostic: createSameFileStaticCssEvalDiagnostic(
        context,
        "mutation-detected",
        "mutated-binding",
        `same-file binding "${options.bindingName}" is mutated`,
        "STATIC_CSS_EVAL_MUTATED_BINDING"
      ),
      metadata
    };
  }

  const unwrappedInit = unwrapTransparentCssRuleExpression(init);
  const initReference = getStaticCssEvalMemberReference(unwrappedInit);

  if (initReference?.kind === "supported") {
    const referencedBinding = options.binding.scope.getBinding(
      initReference.bindingName
    );

    if (!referencedBinding) {
      return { kind: "not-candidate" };
    }

    const referencedResolution = resolveSameFileBindingExpression({
      binding: referencedBinding,
      bindingName: initReference.bindingName,
      memberPath: [...initReference.memberPath, ...options.memberPath],
      ownerFile: options.ownerFile,
      owner: options.owner,
      programPath: options.programPath,
      stack: nextStack
    });

    return prependSameFileMetadata(metadata, referencedResolution);
  }

  if (initReference?.kind === "unsupported") {
    const referencedBinding = options.binding.scope.getBinding(
      initReference.bindingName
    );

    if (!referencedBinding) {
      return { kind: "not-candidate" };
    }

    const baseResolution = resolveSameFileBindingExpression({
      binding: referencedBinding,
      bindingName: initReference.bindingName,
      memberPath: initReference.memberPath,
      ownerFile: options.ownerFile,
      owner: options.owner,
      programPath: options.programPath,
      stack: nextStack
    });

    if (baseResolution.kind !== "resolved") {
      return prependSameFileMetadata(metadata, baseResolution);
    }

    if (
      !isProvenStaticCssRuleMemberTarget(
        baseResolution.expression,
        initReference.unsupportedPropertyName
      )
    ) {
      return { kind: "not-candidate" };
    }

    return {
      kind: "error",
      diagnostic: createUnsupportedMemberReferenceDiagnostic(
        initReference,
        createSameFileContext({
          ...options,
          memberPath: initReference.memberPath
        })
      ),
      metadata: mergeSameFileMetadata(metadata, baseResolution.metadata)
    };
  }

  const resolvedExpression = resolveStaticMemberPath(
    unwrappedInit,
    options.memberPath
  );

  if (resolvedExpression) {
    return {
      kind: "resolved",
      expression: resolvedExpression,
      scope: options.binding.scope,
      metadata
    };
  }

  return { kind: "not-candidate" };
}

function isPotentialStaticCssEvalBindingInit(
  expression: t.Expression,
  memberPath: readonly string[]
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);
  const resolvedExpression = resolveStaticMemberPath(
    unwrappedExpression,
    memberPath
  );

  return (
    Boolean(resolvedExpression && isStaticCssRuleLiteral(resolvedExpression)) ||
    Boolean(getStaticCssEvalMemberReference(unwrappedExpression))
  );
}
