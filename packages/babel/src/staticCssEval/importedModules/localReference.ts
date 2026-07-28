import { types as t } from "@babel/core";
import { unwrapTransparentCssRuleExpression } from "../candidates.js";
import { isStaticCssEvalLiteralRequireCallExpression } from "../cjsBindings.js";
import { containsStaticCssEvalRequireCallExpression } from "../cjsRequireAnalysis.js";
import {
  createStaticCssEvalCjsDynamicRequireUnsupportedDiagnostic,
  createStaticCssEvalCjsUnsupportedDiagnostic,
  createStaticCssEvalDiagnostic,
  createStaticCssEvalDynamicExpressionUnsupportedDiagnostic,
  createStaticCssEvalMutableBindingDiagnostic,
  createStaticCssEvalMutatedBindingDiagnostic
} from "../diagnostics.js";
import { hasStaticCssEvalBindingMutation } from "../sameFile.js";
import type { Binding } from "@babel/traverse";
import type { StaticMemberReference } from "../candidates.js";
import type { StaticCssEvalDiagnostic, StaticCssEvalQuery } from "../types.js";
import type {
  ImportedStaticCssEvalContext,
  ImportedStaticCssEvalDeclarationKind,
  ImportedStaticCssEvalLiteralReferenceOptions,
  ImportedStaticCssEvalLiteralReferenceResult,
  ImportedStaticCssEvalLocalReferenceFrame,
  ImportedStaticCssEvalModuleRecord
} from "./contracts.js";
import {
  createImportedLiteralDiagnosticContext,
  createUnsupportedImportedReferenceResult
} from "./literalDiagnostics.js";
import { evaluateStaticCssLiteralExpression } from "./literalEval.js";
import {
  selectStaticCssEvalExpressionForMemberPath,
  selectStaticCssLiteralMemberPath
} from "./memberPath.js";

export function hasImportedStaticCssBindingMutation(
  record: ImportedStaticCssEvalModuleRecord,
  localName: string
): boolean {
  const binding = record.programPath.scope.getBinding(localName);

  return binding
    ? hasStaticCssEvalBindingMutation(record.programPath, binding)
    : false;
}

export function resolveSameModuleStaticLiteralReference(
  options: ImportedStaticCssEvalLiteralReferenceOptions
): ImportedStaticCssEvalLiteralReferenceResult {
  if (options.reference.kind === "unsupported") {
    return createUnsupportedImportedReferenceResult(options);
  }

  const binding = options.record.programPath.scope.getBinding(
    options.reference.bindingName
  );

  if (!binding) {
    return { kind: "not-candidate" };
  }

  const declarationKind =
    getImportedStaticCssEvalBindingDeclarationKind(binding);
  const init = getImportedStaticCssEvalVariableBindingInitExpression(binding);

  if (!declarationKind || !init) {
    return { kind: "not-candidate" };
  }

  if (declarationKind === "let" || declarationKind === "var") {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalMutableBindingDiagnostic(
        createImportedLiteralDiagnosticContext(options.context),
        options.reference.bindingName
      )
    };
  }

  if (declarationKind !== "const") {
    return { kind: "not-candidate" };
  }

  const currentFrame: ImportedStaticCssEvalLocalReferenceFrame = {
    recordId: options.record.id,
    bindingName: options.reference.bindingName,
    memberPath: [...options.reference.memberPath]
  };
  const cycleStartIndex = findImportedLocalAliasCycleStartIndex(
    options.localStack,
    currentFrame
  );

  if (cycleStartIndex !== -1) {
    return {
      kind: "error",
      diagnostic: createImportedLocalAliasCycleDiagnostic(options.context, [
        ...options.localStack.slice(cycleStartIndex),
        currentFrame
      ])
    };
  }

  if (hasStaticCssEvalBindingMutation(options.record.programPath, binding)) {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalMutatedBindingDiagnostic(
        createImportedLiteralDiagnosticContext(options.context),
        options.reference.bindingName
      )
    };
  }

  const selectedExpression = selectStaticCssEvalExpressionForMemberPath(
    init,
    options.reference.memberPath
  );
  const literalResult = evaluateStaticCssLiteralExpression({
    ...options,
    expression: selectedExpression.expression,
    localStack: [...options.localStack, currentFrame],
    resolveReference: options.resolveReference
  });

  if (literalResult.kind === "error") {
    return literalResult;
  }

  const selectedValue = selectStaticCssLiteralMemberPath(
    literalResult.value,
    selectedExpression.deferredMemberPath
  );

  return selectedValue.kind === "resolved"
    ? selectedValue
    : {
        kind: "error",
        diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          createImportedLiteralDiagnosticContext(options.context),
          selectedExpression.expression.type
        )
      };
}

export function findImportedLocalAliasCycleStartIndex(
  stack: readonly ImportedStaticCssEvalLocalReferenceFrame[],
  currentFrame: ImportedStaticCssEvalLocalReferenceFrame
): number {
  const currentKey = createImportedLocalAliasCycleKey(currentFrame);

  return stack.findIndex(
    (frame) => createImportedLocalAliasCycleKey(frame) === currentKey
  );
}

export function createImportedLocalAliasCycleKey(
  frame: ImportedStaticCssEvalLocalReferenceFrame
): string {
  return JSON.stringify([frame.recordId, frame.bindingName, frame.memberPath]);
}

export function createImportedLocalAliasCycleDiagnostic(
  context: ImportedStaticCssEvalContext,
  cycle: readonly ImportedStaticCssEvalLocalReferenceFrame[]
): StaticCssEvalDiagnostic {
  const importChain = cycle.map(formatImportedLocalAliasCycleFrame);

  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_LOCAL_ALIAS_CYCLE",
    code: "cycle-detected",
    reason: "runtime-dynamic-value",
    detail: `cyclic imported static css alias detected: ${importChain.join(
      " -> "
    )}`,
    ...createImportedLiteralDiagnosticContext(context),
    importChain
  });
}

export function formatImportedLocalAliasCycleFrame(
  frame: ImportedStaticCssEvalLocalReferenceFrame
): string {
  const memberPath = frame.memberPath.length
    ? `.${frame.memberPath.join(".")}`
    : "";

  return `${frame.recordId}#${frame.bindingName}${memberPath}`;
}

export function createDynamicRequireOperandDiagnostic(
  options: ImportedStaticCssEvalLiteralReferenceOptions
): StaticCssEvalDiagnostic | null {
  const binding = options.record.programPath.scope.getBinding(
    options.reference.bindingName
  );
  const init = binding
    ? getImportedStaticCssEvalVariableBindingInitExpression(binding)
    : null;
  const unwrappedInit = init ? unwrapTransparentCssRuleExpression(init) : null;

  if (
    !unwrappedInit ||
    !containsStaticCssEvalRequireCallExpression(
      unwrappedInit,
      options.record.programPath.scope
    )
  ) {
    return null;
  }

  const context = createImportedLiteralDiagnosticContext(options.context);

  return isStaticCssEvalLiteralRequireCallExpression(
    unwrappedInit,
    options.record.programPath.scope
  )
    ? createStaticCssEvalCjsUnsupportedDiagnostic(context)
    : createStaticCssEvalCjsDynamicRequireUnsupportedDiagnostic(context);
}

export function createReferenceQuery(
  importerId: string,
  reference: Extract<StaticMemberReference, { kind: "supported" }>
): StaticCssEvalQuery {
  return {
    importerId,
    expressionStart: reference.expressionStart,
    expressionEnd: reference.expressionEnd,
    bindingName: reference.bindingName,
    ...(reference.memberPath.length > 0
      ? { memberPath: [...reference.memberPath] }
      : {})
  };
}

export function getImportedStaticCssEvalBindingDeclarationKind(
  binding: Binding
): ImportedStaticCssEvalDeclarationKind | null {
  const bindingPath = binding.path;

  if (bindingPath.isVariableDeclarator()) {
    if (!t.isIdentifier(bindingPath.node.id)) {
      return null;
    }

    if (!bindingPath.parentPath.isVariableDeclaration()) {
      return null;
    }

    const { kind } = bindingPath.parentPath.node;
    return kind === "const" || kind === "let" || kind === "var" ? kind : null;
  }

  if (bindingPath.isFunctionDeclaration()) {
    return "function";
  }

  if (bindingPath.isClassDeclaration()) {
    return "class";
  }

  return null;
}

export function getImportedStaticCssEvalVariableBindingInitExpression(
  binding: Binding
): t.Expression | null {
  const bindingPath = binding.path;

  if (
    !bindingPath.isVariableDeclarator() ||
    !t.isIdentifier(bindingPath.node.id)
  ) {
    return null;
  }

  const initPath = bindingPath.get("init");

  if (!initPath.node || !initPath.isExpression()) {
    return null;
  }

  return initPath.node;
}
