import { types as t } from "@babel/core";
import { createStaticCssEvalDiagnostic } from "../diagnostics.js";
import type {
  BindingProvenance,
  StaticCssEvalDiagnostic,
  StaticCssEvalSourceLocation
} from "../types.js";
import type {
  SameFileBindingResolutionOptions,
  SameFileBindingResolutionResult,
  SameFileBindingStackFrame,
  SameFileDeclarationKind,
  SameFileStaticCssEvalContext,
  SameFileStaticCssEvalMetadata,
  SameFileStaticCssEvalResult
} from "./types.js";

export function createSameFileContext(
  options: Pick<
    SameFileBindingResolutionOptions,
    "bindingName" | "memberPath" | "owner"
  >
): SameFileStaticCssEvalContext {
  return {
    bindingName: options.bindingName,
    memberPath: [...options.memberPath],
    owner: options.owner
  };
}

export function createSameFileDiagnosticContext(
  context: SameFileStaticCssEvalContext
): {
  owner: StaticCssEvalSourceLocation;
  memberPath?: readonly string[];
} {
  return {
    owner: context.owner,
    ...(context.memberPath.length > 0 ? { memberPath: context.memberPath } : {})
  };
}

export function prependSameFileMetadata(
  metadata: SameFileStaticCssEvalMetadata,
  result: SameFileBindingResolutionResult
): SameFileBindingResolutionResult {
  if (result.kind === "not-candidate") {
    return result;
  }

  if (result.kind === "error") {
    return {
      kind: "error",
      diagnostic: result.diagnostic,
      metadata: result.metadata
        ? mergeSameFileMetadata(metadata, result.metadata)
        : metadata
    };
  }

  return {
    kind: "resolved",
    expression: result.expression,
    scope: result.scope,
    metadata: mergeSameFileMetadata(metadata, result.metadata)
  };
}

export function mergeSameFileMetadata(
  parent: SameFileStaticCssEvalMetadata,
  child: SameFileStaticCssEvalMetadata
): SameFileStaticCssEvalMetadata {
  return {
    provenance: parent.provenance,
    dependencies: [...parent.dependencies, ...child.dependencies],
    resolutionChain: [...parent.resolutionChain, ...child.resolutionChain]
  };
}

export function createSameFileMetadata(
  ownerFile: string,
  bindingName: string,
  memberPath: readonly string[],
  declarationKind: SameFileDeclarationKind
): SameFileStaticCssEvalMetadata {
  const provenance: BindingProvenance = {
    kind: "local",
    file: ownerFile,
    bindingName,
    declarationKind
  };

  return {
    provenance,
    dependencies: [
      {
        file: ownerFile,
        kind: "local",
        importer: ownerFile,
        specifier: "<local>",
        exportName: bindingName,
        memberPath: [...memberPath],
        inspected: true,
        contributed: true
      }
    ],
    resolutionChain: [
      {
        importer: ownerFile,
        source: ownerFile,
        exportName: bindingName,
        memberPath: [...memberPath],
        provenance
      }
    ]
  };
}

export function createSameFileInlineMetadata(
  ownerFile: string
): SameFileStaticCssEvalMetadata {
  return {
    provenance: {
      kind: "local",
      file: ownerFile,
      bindingName: "<inline>"
    },
    dependencies: [],
    resolutionChain: []
  };
}

export function createSameFileResolvedResult(
  expression: t.ObjectExpression | t.ArrayExpression,
  metadata: SameFileStaticCssEvalMetadata
): SameFileStaticCssEvalResult {
  return {
    kind: "resolved",
    status: "resolved",
    expression,
    provenance: metadata.provenance,
    dependencies: metadata.dependencies,
    resolutionChain: metadata.resolutionChain,
    diagnostics: []
  };
}

export function createSameFileErrorResult(
  diagnostic: StaticCssEvalDiagnostic,
  metadata?: SameFileStaticCssEvalMetadata
): SameFileStaticCssEvalResult {
  return {
    kind: "error",
    status: "error",
    diagnostic,
    diagnostics: [diagnostic],
    ...(metadata
      ? {
          provenance: metadata.provenance,
          dependencies: metadata.dependencies,
          resolutionChain: metadata.resolutionChain
        }
      : { dependencies: [] })
  };
}

export function createSameFileUnsupportedResult(
  diagnostic: StaticCssEvalDiagnostic,
  metadata?: SameFileStaticCssEvalMetadata
): SameFileStaticCssEvalResult {
  return {
    kind: "not-candidate",
    status: "unsupported",
    diagnostic,
    diagnostics: [diagnostic],
    ...(metadata
      ? {
          provenance: metadata.provenance,
          dependencies: metadata.dependencies,
          resolutionChain: metadata.resolutionChain
        }
      : { dependencies: [] })
  };
}

export function findSameFileAliasCycleStartIndex(
  stack: readonly SameFileBindingStackFrame[],
  currentFrame: SameFileBindingStackFrame
): number {
  const currentKey = createSameFileAliasCycleKey(currentFrame);

  return stack.findIndex(
    (frame) =>
      frame.binding === currentFrame.binding &&
      createSameFileAliasCycleKey(frame) === currentKey
  );
}

function createSameFileAliasCycleKey(frame: SameFileBindingStackFrame): string {
  return JSON.stringify(frame.memberPath);
}

export function createSameFileLocalAliasCycleDiagnostic(
  context: SameFileStaticCssEvalContext,
  ownerFile: string,
  cycle: readonly SameFileBindingStackFrame[]
): StaticCssEvalDiagnostic {
  const importChain = cycle.map((frame) =>
    formatSameFileAliasCycleFrame(ownerFile, frame)
  );

  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_LOCAL_ALIAS_CYCLE",
    code: "cycle-detected",
    reason: "runtime-dynamic-value",
    detail: `cyclic same-file static css alias detected: ${importChain.join(
      " -> "
    )}`,
    owner: context.owner,
    dependency: { file: ownerFile },
    exportName: context.bindingName,
    memberPath: context.memberPath,
    importChain
  });
}

function formatSameFileAliasCycleFrame(
  ownerFile: string,
  frame: SameFileBindingStackFrame
): string {
  const memberPath = frame.memberPath.length
    ? `.${frame.memberPath.join(".")}`
    : "";

  return `${ownerFile}#${frame.bindingName}${memberPath}`;
}
