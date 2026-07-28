import { types as t } from "@babel/core";
import { getUnsupportedLiteralReason } from "../ast.js";
import { unwrapTransparentCssRuleExpression } from "../candidates.js";
import {
  createStaticCssEvalComputedMemberUnsupportedDiagnostic,
  createStaticCssEvalDiagnostic,
  createStaticCssEvalDynamicExpressionUnsupportedDiagnostic,
  createStaticCssEvalObjectSpreadUnsupportedDiagnostic
} from "../diagnostics.js";
import {
  enforceStaticCssEvalLiteralNodeCount,
  enforceStaticCssEvalObjectArrayRecursionDepth
} from "../limits.js";
import type {
  StaticCssEvalDiagnostic,
  StaticCssEvalExportName,
  StaticCssEvalQuery,
  StaticCssEvalSourceLocation,
  StaticCssEvalUnsupportedReason
} from "../types.js";
import type {
  ImportedStaticCssEvalContext,
  ImportedStaticCssEvalLiteralEvaluationOptions,
  ImportedStaticCssEvalLiteralReferenceOptions,
  ImportedStaticCssEvalLiteralResult,
  StaticCssLiteralValidationState
} from "./contracts.js";
import { formatExportName } from "./format.js";

export function createUnsupportedImportedReferenceResult(
  options: ImportedStaticCssEvalLiteralReferenceOptions
): ImportedStaticCssEvalLiteralResult {
  if (options.reference.kind !== "unsupported") {
    return createUnsupportedImportedLiteralResult(options, options.expression);
  }

  if (options.reference.reason === "optional-member-path") {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
        createImportedLiteralDiagnosticContext(options.context),
        options.expression.type,
        options.reference.detail
      )
    };
  }

  return {
    kind: "error",
    diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
      createImportedLiteralDiagnosticContext(options.context)
    )
  };
}

export function createUnsupportedImportedLiteralResult(
  options: Pick<ImportedStaticCssEvalLiteralEvaluationOptions, "context">,
  expression: t.Expression
): ImportedStaticCssEvalLiteralResult {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return {
    kind: "error",
    diagnostic: createImportedStaticCssEvalDiagnostic({
      ...options.context,
      code: "unsupported-syntax",
      reason: getUnsupportedLiteralReason(unwrappedExpression),
      detail: createUnsupportedLiteralDetail(
        options.context.exportName,
        unwrappedExpression
      )
    })
  };
}

export function createImportedObjectSpreadError(
  context: ImportedStaticCssEvalContext,
  collection: "object" | "array"
): ImportedStaticCssEvalLiteralResult {
  return {
    kind: "error",
    diagnostic: createStaticCssEvalObjectSpreadUnsupportedDiagnostic(
      createImportedLiteralDiagnosticContext(context),
      formatExportName(context.exportName),
      collection
    )
  };
}

export function createImportedLiteralDiagnosticContext(
  context: ImportedStaticCssEvalContext
): {
  readonly owner: StaticCssEvalSourceLocation;
  readonly dependency: StaticCssEvalSourceLocation;
  readonly importPath: string;
  readonly exportName: StaticCssEvalExportName;
  readonly memberPath: readonly string[];
} {
  return {
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath
  };
}

export function enforceImportedStaticCssEvalDepth(
  context: ImportedStaticCssEvalContext,
  depth: number
): StaticCssEvalDiagnostic | null {
  const result = enforceStaticCssEvalObjectArrayRecursionDepth({
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    recursionDepth: depth
  });

  return result.ok ? null : result.diagnostic;
}

export function enforceImportedStaticCssEvalLiteralCount(
  context: ImportedStaticCssEvalContext,
  state: StaticCssLiteralValidationState
): StaticCssEvalDiagnostic | null {
  const result = enforceStaticCssEvalLiteralNodeCount({
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    literalNodeCount: state.count
  });

  return result.ok ? null : result.diagnostic;
}

export function createStaticCssLiteralError(
  context: ImportedStaticCssEvalContext,
  reason: StaticCssEvalUnsupportedReason,
  detail: string
): { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  return {
    kind: "error",
    diagnostic: createImportedStaticCssEvalDiagnostic({
      ...context,
      code: "unsupported-syntax",
      reason,
      detail
    })
  };
}

export function createImportedStaticCssEvalDiagnostic(
  options: ImportedStaticCssEvalContext & {
    code: StaticCssEvalDiagnostic["code"];
    reason: StaticCssEvalUnsupportedReason;
    detail: string;
  }
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    code: options.code,
    reason: options.reason,
    detail: options.detail,
    owner: options.owner,
    dependency: options.dependency,
    importPath: options.importPath,
    exportName: options.exportName,
    memberPath: options.memberPath,
    importChain: [
      options.owner.file,
      `${options.dependency.file}#${formatExportName(options.exportName)}${
        options.memberPath.length > 0 ? `.${options.memberPath.join(".")}` : ""
      }`
    ]
  });
}

export function createQueryOwnerLocation(
  query: StaticCssEvalQuery
): StaticCssEvalSourceLocation {
  return {
    file: query.importerId,
    start: query.expressionStart,
    end: query.expressionEnd
  };
}

export function createExpressionOwnerLocation(
  expression: t.Expression,
  ownerFile: string
): StaticCssEvalSourceLocation {
  return {
    file: ownerFile,
    ...(typeof expression.start === "number"
      ? { start: expression.start }
      : {}),
    ...(typeof expression.end === "number" ? { end: expression.end } : {})
  };
}
export function createUnsupportedLiteralDetail(
  exportName: StaticCssEvalExportName,
  expression: t.Expression
): string {
  if (getUnsupportedLiteralReason(expression) === "dynamic-import") {
    return `imported export "${formatExportName(exportName)}" contains a dynamic import`;
  }

  return `imported export "${formatExportName(
    exportName
  )}" contains unsupported ${expression.type}`;
}
