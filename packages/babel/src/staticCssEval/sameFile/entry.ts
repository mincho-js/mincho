import {
  getStaticCssEvalMemberReference,
  unwrapTransparentCssRuleExpression
} from "../candidates.js";
import { resolveSameFileBindingExpression } from "./binding.js";
import { createUnsupportedMemberReferenceDiagnostic } from "./diagnostics.js";
import { evaluateSameFileStaticLiteralExpression } from "./evaluator.js";
import {
  createSameFileErrorResult,
  createSameFileInlineMetadata,
  createSameFileResolvedResult,
  createSameFileUnsupportedResult
} from "./metadata.js";
import type {
  ResolveSameFileStaticCssEvalOptions,
  SameFileStaticCssEvalContext,
  SameFileStaticCssEvalResult
} from "./types.js";
import {
  getExpressionRange,
  isComputedOrOptionalMemberExpression,
  isProvenStaticCssRuleMemberTarget,
  isStaticCssRuleLiteral,
  shouldTreatStaticMemberMissAsNotCandidate
} from "./shapes.js";

export function resolveSameFileStaticCssEvalExpression(
  options: ResolveSameFileStaticCssEvalOptions
): SameFileStaticCssEvalResult {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );
  const expressionRange = getExpressionRange(unwrappedExpression);

  if (!expressionRange) {
    return { kind: "not-candidate" };
  }

  if (isStaticCssRuleLiteral(unwrappedExpression)) {
    const context: SameFileStaticCssEvalContext = {
      bindingName: "<inline>",
      memberPath: [],
      owner: {
        file: options.ownerFile,
        start: expressionRange.start,
        end: expressionRange.end
      }
    };
    const normalizedLiteral = evaluateSameFileStaticLiteralExpression({
      expression: unwrappedExpression,
      context,
      ownerFile: options.ownerFile,
      programPath: options.programPath,
      scope: options.scope,
      stack: [],
      state: { count: 0 },
      depth: 1,
      metadata: createSameFileInlineMetadata(options.ownerFile)
    });

    if (normalizedLiteral.kind === "error") {
      return createSameFileErrorResult(
        normalizedLiteral.diagnostic,
        normalizedLiteral.metadata
      );
    }

    if (!isStaticCssRuleLiteral(normalizedLiteral.expression)) {
      return { kind: "not-candidate" };
    }

    return createSameFileResolvedResult(
      normalizedLiteral.expression,
      normalizedLiteral.metadata
    );
  }

  if (isComputedOrOptionalMemberExpression(unwrappedExpression)) {
    const context: SameFileStaticCssEvalContext = {
      bindingName: "<inline>",
      memberPath: [],
      owner: {
        file: options.ownerFile,
        start: expressionRange.start,
        end: expressionRange.end
      }
    };
    const memberResult = evaluateSameFileStaticLiteralExpression({
      expression: unwrappedExpression,
      context,
      ownerFile: options.ownerFile,
      programPath: options.programPath,
      scope: options.scope,
      stack: [],
      state: { count: 0 },
      depth: 1,
      metadata: createSameFileInlineMetadata(options.ownerFile)
    });

    if (memberResult.kind === "error") {
      if (
        shouldTreatStaticMemberMissAsNotCandidate(
          unwrappedExpression,
          memberResult.diagnostic
        )
      ) {
        return { kind: "not-candidate" };
      }

      return createSameFileErrorResult(
        memberResult.diagnostic,
        memberResult.metadata
      );
    }

    return isStaticCssRuleLiteral(memberResult.expression)
      ? createSameFileResolvedResult(
          memberResult.expression,
          memberResult.metadata
        )
      : { kind: "not-candidate" };
  }

  const reference = getStaticCssEvalMemberReference(unwrappedExpression);

  if (!reference) {
    return { kind: "not-candidate" };
  }

  const binding = options.scope.getBinding(reference.bindingName);

  if (!binding) {
    return { kind: "not-candidate" };
  }

  const memberPath = reference.memberPath;
  const context: SameFileStaticCssEvalContext = {
    bindingName: reference.bindingName,
    memberPath,
    owner: {
      file: options.ownerFile,
      start: expressionRange.start,
      end: expressionRange.end
    }
  };

  if (reference.kind === "unsupported") {
    const baseResolution = resolveSameFileBindingExpression({
      binding,
      bindingName: reference.bindingName,
      memberPath,
      ownerFile: options.ownerFile,
      owner: context.owner,
      programPath: options.programPath,
      stack: []
    });

    if (baseResolution.kind === "error") {
      return createSameFileErrorResult(
        baseResolution.diagnostic,
        baseResolution.metadata
      );
    }

    if (
      baseResolution.kind !== "resolved" ||
      !isProvenStaticCssRuleMemberTarget(
        baseResolution.expression,
        reference.unsupportedPropertyName
      )
    ) {
      return { kind: "not-candidate" };
    }

    return createSameFileErrorResult(
      createUnsupportedMemberReferenceDiagnostic(reference, context),
      baseResolution.metadata
    );
  }

  const bindingResolution = resolveSameFileBindingExpression({
    binding,
    bindingName: reference.bindingName,
    memberPath,
    ownerFile: options.ownerFile,
    owner: context.owner,
    programPath: options.programPath,
    stack: []
  });

  if (bindingResolution.kind === "error") {
    if (bindingResolution.diagnostic.id === "STATIC_CSS_EVAL_MUTABLE_BINDING") {
      return createSameFileUnsupportedResult(
        bindingResolution.diagnostic,
        bindingResolution.metadata
      );
    }

    return createSameFileErrorResult(
      bindingResolution.diagnostic,
      bindingResolution.metadata
    );
  }

  if (bindingResolution.kind === "not-candidate") {
    return { kind: "not-candidate" };
  }

  const resolvedExpression = bindingResolution.expression;

  if (!isStaticCssRuleLiteral(resolvedExpression)) {
    return { kind: "not-candidate" };
  }

  const normalizedLiteral = evaluateSameFileStaticLiteralExpression({
    expression: resolvedExpression,
    context,
    ownerFile: options.ownerFile,
    programPath: options.programPath,
    scope: bindingResolution.scope,
    stack: [{ binding, bindingName: reference.bindingName, memberPath }],
    state: { count: 0 },
    depth: 1,
    metadata: bindingResolution.metadata
  });

  if (normalizedLiteral.kind === "error") {
    return createSameFileErrorResult(
      normalizedLiteral.diagnostic,
      normalizedLiteral.metadata
    );
  }

  if (!isStaticCssRuleLiteral(normalizedLiteral.expression)) {
    return { kind: "not-candidate" };
  }

  return createSameFileResolvedResult(
    normalizedLiteral.expression,
    normalizedLiteral.metadata
  );
}
