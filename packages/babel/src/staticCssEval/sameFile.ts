import { transformSync, types as t } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";
import type { Binding, Scope } from "@babel/traverse";
import {
  getStaticMemberPropertyName,
  getStaticObjectMemberValue,
  getStaticObjectPropertyName,
  getUnsupportedLiteralReason,
  preserveDirectBooleanReferenceValue
} from "./ast.js";
import {
  getStaticCssEvalMemberReference,
  unwrapTransparentCssRuleExpression
} from "./candidates.js";
import type { StaticMemberReference } from "./candidates.js";
import {
  createStaticCssEvalComputedMemberUnsupportedDiagnostic,
  createStaticCssEvalDiagnostic,
  createStaticCssEvalDynamicExpressionUnsupportedDiagnostic,
  createStaticCssEvalMutableBindingDiagnostic,
  createStaticCssEvalObjectSpreadUnsupportedDiagnostic,
  guardStaticCssEvalResolutionDepth
} from "./diagnostics.js";
import {
  enforceStaticCssEvalLiteralNodeCount,
  enforceStaticCssEvalObjectArrayRecursionDepth
} from "./limits.js";
import type {
  BindingProvenance,
  ResolutionChainEntry,
  ResolutionDependency,
  StaticCssEvalDiagnostic,
  StaticCssEvalSourceLocation,
  StaticCssEvalUnsupportedReason
} from "./types.js";

export type SameFileStaticCssEvalResult =
  | {
      kind: "not-candidate";
      status?: "unsupported";
      diagnostic?: StaticCssEvalDiagnostic;
      diagnostics?: StaticCssEvalDiagnostic[];
      provenance?: BindingProvenance;
      dependencies?: ResolutionDependency[];
      resolutionChain?: ResolutionChainEntry[];
    }
  | {
      kind: "resolved";
      status: "resolved";
      expression: t.ObjectExpression | t.ArrayExpression;
      provenance: BindingProvenance;
      dependencies: ResolutionDependency[];
      resolutionChain: ResolutionChainEntry[];
      diagnostics: [];
    }
  | {
      kind: "error";
      status: "error";
      diagnostic: StaticCssEvalDiagnostic;
      diagnostics: StaticCssEvalDiagnostic[];
      provenance?: BindingProvenance;
      dependencies: ResolutionDependency[];
      resolutionChain?: ResolutionChainEntry[];
    };

export interface ResolveSameFileStaticCssEvalOptions {
  expression: t.Expression;
  ownerFile: string;
  programPath: NodePath<t.Program>;
  scope: Scope;
}

interface SameFileStaticCssEvalContext {
  bindingName: string;
  memberPath: string[];
  owner: StaticCssEvalSourceLocation;
}

interface SameFileStaticCssEvalMetadata {
  provenance: BindingProvenance;
  dependencies: ResolutionDependency[];
  resolutionChain: ResolutionChainEntry[];
}

type SameFileBindingResolutionResult =
  | { kind: "not-candidate" }
  | {
      kind: "resolved";
      expression: t.Expression;
      scope: Scope;
      metadata: SameFileStaticCssEvalMetadata;
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata?: SameFileStaticCssEvalMetadata;
    };

interface SameFileBindingResolutionOptions {
  binding: Binding;
  bindingName: string;
  memberPath: string[];
  ownerFile: string;
  owner: StaticCssEvalSourceLocation;
  programPath: NodePath<t.Program>;
  stack: SameFileBindingStackFrame[];
}

interface SameFileBindingStackFrame {
  binding: Binding;
  bindingName: string;
  memberPath: string[];
}

type SameFileDeclarationKind = "const" | "let" | "var" | "function" | "class";

interface LiteralValidationState {
  count: number;
}

type SameFileStaticLiteralEvaluationResult =
  | {
      kind: "resolved";
      expression: t.Expression;
      metadata: SameFileStaticCssEvalMetadata;
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata?: SameFileStaticCssEvalMetadata;
    };

interface SameFileStaticLiteralEvaluationOptions {
  expression: t.Expression;
  context: SameFileStaticCssEvalContext;
  ownerFile: string;
  programPath: NodePath<t.Program>;
  scope: Scope;
  stack: SameFileBindingStackFrame[];
  state: LiteralValidationState;
  depth: number;
  metadata: SameFileStaticCssEvalMetadata;
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

function resolveSameFileBindingExpression(
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
    return options.memberPath.length === 0 &&
      isPotentialStaticCssEvalBindingInit(init, options.memberPath)
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

function createSameFileContext(
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

function createSameFileDiagnosticContext(
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

function prependSameFileMetadata(
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

function mergeSameFileMetadata(
  parent: SameFileStaticCssEvalMetadata,
  child: SameFileStaticCssEvalMetadata
): SameFileStaticCssEvalMetadata {
  return {
    provenance: parent.provenance,
    dependencies: [...parent.dependencies, ...child.dependencies],
    resolutionChain: [...parent.resolutionChain, ...child.resolutionChain]
  };
}

function createSameFileMetadata(
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

function createSameFileInlineMetadata(
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

function createSameFileResolvedResult(
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

function createSameFileErrorResult(
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

function createSameFileUnsupportedResult(
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

function findSameFileAliasCycleStartIndex(
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

function createSameFileLocalAliasCycleDiagnostic(
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

function createUnsupportedMemberReferenceDiagnostic(
  reference: Extract<StaticMemberReference, { kind: "unsupported" }>,
  context: SameFileStaticCssEvalContext
): StaticCssEvalDiagnostic {
  if (reference.reason === "optional-member-path") {
    return createSameFileStaticCssEvalDiagnostic(
      context,
      "unsupported-syntax",
      reference.reason,
      `same-file binding "${context.bindingName}" contains unsupported ${reference.reason}: ${reference.detail}`,
      "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
    );
  }

  return createSameFileStaticCssEvalDiagnostic(
    context,
    "unsupported-syntax",
    reference.reason,
    `same-file binding "${context.bindingName}" contains unsupported ${reference.reason}: ${reference.detail}`,
    "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED"
  );
}

function createUnsupportedDynamicExpressionDiagnostic(
  context: SameFileStaticCssEvalContext,
  expression: t.Expression
): StaticCssEvalDiagnostic | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  const memberReference = getStaticCssEvalMemberReference(unwrappedExpression);

  if (memberReference?.kind === "unsupported") {
    return createUnsupportedMemberReferenceDiagnostic(memberReference, context);
  }

  if (isSupportedStaticCssPrimitiveLiteral(unwrappedExpression)) {
    return null;
  }

  if (
    t.isCallExpression(unwrappedExpression) ||
    t.isOptionalCallExpression(unwrappedExpression) ||
    t.isNewExpression(unwrappedExpression) ||
    t.isFunctionExpression(unwrappedExpression) ||
    t.isArrowFunctionExpression(unwrappedExpression) ||
    t.isConditionalExpression(unwrappedExpression) ||
    t.isLogicalExpression(unwrappedExpression) ||
    t.isBinaryExpression(unwrappedExpression) ||
    t.isTaggedTemplateExpression(unwrappedExpression) ||
    t.isOptionalMemberExpression(unwrappedExpression)
  ) {
    return createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
      createSameFileDiagnosticContext(context),
      unwrappedExpression.type
    );
  }

  return null;
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
  if (getStaticCssEvalBindingDeclarationKind(binding) !== "const") {
    return null;
  }

  return getStaticCssEvalVariableBindingInitExpression(binding);
}

function getStaticCssEvalBindingDeclarationKind(
  binding: Binding
): SameFileDeclarationKind | null {
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

function getStaticCssEvalVariableBindingInitExpression(
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

function evaluateSameFileStaticLiteralExpression(
  options: SameFileStaticLiteralEvaluationOptions
): SameFileStaticLiteralEvaluationResult {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );
  options.state.count += 1;

  const countResult = enforceStaticCssEvalLiteralNodeCount({
    owner: options.context.owner,
    memberPath: options.context.memberPath,
    literalNodeCount: options.state.count
  });

  if (!countResult.ok) {
    return {
      kind: "error",
      diagnostic: countResult.diagnostic,
      metadata: options.metadata
    };
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    const depthResult = enforceStaticCssEvalObjectArrayRecursionDepth({
      owner: options.context.owner,
      memberPath: options.context.memberPath,
      recursionDepth: options.depth
    });

    if (!depthResult.ok) {
      return {
        kind: "error",
        diagnostic: depthResult.diagnostic,
        metadata: options.metadata
      };
    }

    return evaluateSameFileStaticObjectExpression({
      ...options,
      expression: unwrappedExpression
    });
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    const depthResult = enforceStaticCssEvalObjectArrayRecursionDepth({
      owner: options.context.owner,
      memberPath: options.context.memberPath,
      recursionDepth: options.depth
    });

    if (!depthResult.ok) {
      return {
        kind: "error",
        diagnostic: depthResult.diagnostic,
        metadata: options.metadata
      };
    }

    return evaluateSameFileStaticArrayExpression({
      ...options,
      expression: unwrappedExpression
    });
  }

  if (isSupportedStaticCssPrimitiveLiteral(unwrappedExpression)) {
    return {
      kind: "resolved",
      expression:
        normalizeSupportedStaticCssPrimitiveLiteral(unwrappedExpression),
      metadata: options.metadata
    };
  }

  const reference = getStaticCssEvalMemberReference(unwrappedExpression);

  if (reference) {
    return evaluateSameFileStaticLiteralReference(options, reference);
  }

  return {
    kind: "error",
    diagnostic: createUnsupportedLiteralDiagnostic(
      options.context,
      unwrappedExpression
    ),
    metadata: options.metadata
  };
}

function evaluateSameFileStaticObjectExpression(
  options: SameFileStaticLiteralEvaluationOptions & {
    expression: t.ObjectExpression;
  }
): SameFileStaticLiteralEvaluationResult {
  const properties: t.ObjectExpression["properties"] = [];
  let metadata = options.metadata;

  for (const property of options.expression.properties) {
    if (t.isSpreadElement(property)) {
      const spreadResult = evaluateSameFileStaticLiteralExpression({
        ...options,
        expression: property.argument,
        metadata,
        depth: options.depth + 1
      });

      if (spreadResult.kind === "error") {
        return spreadResult;
      }

      metadata = spreadResult.metadata;

      if (!t.isObjectExpression(spreadResult.expression)) {
        return {
          kind: "error",
          diagnostic: createStaticCssEvalObjectSpreadUnsupportedDiagnostic(
            createSameFileDiagnosticContext(options.context),
            options.context.bindingName,
            "object"
          ),
          metadata
        };
      }

      properties.push(
        ...spreadResult.expression.properties.map((spreadProperty) =>
          t.cloneNode(spreadProperty)
        )
      );
      continue;
    }

    if (!t.isObjectProperty(property)) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          createSameFileDiagnosticContext(options.context),
          property.type
        ),
        metadata
      };
    }

    if (property.computed) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
          createSameFileDiagnosticContext(options.context)
        ),
        metadata
      };
    }

    if (!t.isExpression(property.value)) {
      return {
        kind: "error",
        diagnostic: createSameFileStaticCssEvalDiagnostic(
          options.context,
          "unsupported-syntax",
          "unsupported-literal",
          `same-file binding "${options.context.bindingName}" contains a non-expression object value`
        ),
        metadata
      };
    }

    const valueResult = evaluateSameFileStaticLiteralExpression({
      ...options,
      expression: property.value,
      metadata,
      depth: options.depth + 1
    });

    if (valueResult.kind === "error") {
      return valueResult;
    }

    metadata = valueResult.metadata;

    const nextProperty = t.cloneNode(property);
    nextProperty.value = preserveDirectBooleanReferenceValue(
      property.value,
      valueResult.expression
    );
    nextProperty.shorthand = false;
    properties.push(nextProperty);
  }

  const normalizedProperties: t.ObjectExpression["properties"] = [];
  const propertyIndexes = new Map<string, number>();

  for (const property of properties) {
    if (!t.isObjectProperty(property) || property.computed) {
      normalizedProperties.push(property);
      continue;
    }

    const propertyName = getStaticObjectPropertyName(property.key);
    const existingIndex =
      propertyName === null ? undefined : propertyIndexes.get(propertyName);

    if (existingIndex === undefined) {
      if (propertyName !== null) {
        propertyIndexes.set(propertyName, normalizedProperties.length);
      }

      normalizedProperties.push(property);
      continue;
    }

    normalizedProperties[existingIndex] = property;
  }

  return {
    kind: "resolved",
    expression: t.objectExpression(normalizedProperties),
    metadata
  };
}

function evaluateSameFileStaticArrayExpression(
  options: SameFileStaticLiteralEvaluationOptions & {
    expression: t.ArrayExpression;
  }
): SameFileStaticLiteralEvaluationResult {
  const elements: t.ArrayExpression["elements"] = [];
  let metadata = options.metadata;

  for (const element of options.expression.elements) {
    if (!element) {
      return {
        kind: "error",
        diagnostic: createSameFileArrayHoleDiagnostic(options.context),
        metadata
      };
    }

    if (t.isSpreadElement(element)) {
      const spreadResult = evaluateSameFileStaticLiteralExpression({
        ...options,
        expression: element.argument,
        metadata,
        depth: options.depth + 1
      });

      if (spreadResult.kind === "error") {
        return spreadResult;
      }

      metadata = spreadResult.metadata;

      if (!t.isArrayExpression(spreadResult.expression)) {
        return {
          kind: "error",
          diagnostic: createStaticCssEvalObjectSpreadUnsupportedDiagnostic(
            createSameFileDiagnosticContext(options.context),
            options.context.bindingName,
            "array"
          ),
          metadata
        };
      }

      for (const spreadElement of spreadResult.expression.elements) {
        if (!spreadElement) {
          return {
            kind: "error",
            diagnostic: createSameFileArrayHoleDiagnostic(options.context),
            metadata
          };
        }

        if (t.isSpreadElement(spreadElement)) {
          return {
            kind: "error",
            diagnostic: createStaticCssEvalObjectSpreadUnsupportedDiagnostic(
              createSameFileDiagnosticContext(options.context),
              options.context.bindingName,
              "array"
            ),
            metadata
          };
        }

        elements.push(t.cloneNode(spreadElement));
      }
      continue;
    }

    const elementResult = evaluateSameFileStaticLiteralExpression({
      ...options,
      expression: element,
      metadata,
      depth: options.depth + 1
    });

    if (elementResult.kind === "error") {
      return elementResult;
    }

    metadata = elementResult.metadata;
    elements.push(
      preserveDirectBooleanReferenceValue(element, elementResult.expression)
    );
  }

  return {
    kind: "resolved",
    expression: t.arrayExpression(elements),
    metadata
  };
}

function evaluateSameFileStaticLiteralReference(
  options: SameFileStaticLiteralEvaluationOptions,
  reference: StaticMemberReference
): SameFileStaticLiteralEvaluationResult {
  if (reference.kind === "unsupported") {
    return {
      kind: "error",
      diagnostic: createUnsupportedMemberReferenceDiagnostic(
        reference,
        options.context
      ),
      metadata: options.metadata
    };
  }

  const binding = options.scope.getBinding(reference.bindingName);

  if (!binding) {
    return {
      kind: "error",
      diagnostic: createUnsupportedLiteralDiagnostic(
        options.context,
        options.expression
      ),
      metadata: options.metadata
    };
  }

  const bindingResolution = resolveSameFileBindingExpression({
    binding,
    bindingName: reference.bindingName,
    memberPath: reference.memberPath,
    ownerFile: options.ownerFile,
    owner: options.context.owner,
    programPath: options.programPath,
    stack: options.stack
  });

  if (bindingResolution.kind === "error") {
    return {
      kind: "error",
      diagnostic: bindingResolution.diagnostic,
      metadata: bindingResolution.metadata
        ? mergeSameFileMetadata(options.metadata, bindingResolution.metadata)
        : options.metadata
    };
  }

  if (bindingResolution.kind === "not-candidate") {
    return {
      kind: "error",
      diagnostic: createUnsupportedLiteralDiagnostic(
        options.context,
        options.expression
      ),
      metadata: options.metadata
    };
  }

  return evaluateSameFileStaticLiteralExpression({
    ...options,
    expression: bindingResolution.expression,
    scope: bindingResolution.scope,
    stack: [
      ...options.stack,
      {
        binding,
        bindingName: reference.bindingName,
        memberPath: [...reference.memberPath]
      }
    ],
    metadata: mergeSameFileMetadata(
      options.metadata,
      bindingResolution.metadata
    )
  });
}

function createSameFileArrayHoleDiagnostic(
  context: SameFileStaticCssEvalContext
): StaticCssEvalDiagnostic {
  return createSameFileStaticCssEvalDiagnostic(
    context,
    "unsupported-syntax",
    "unsupported-literal",
    `same-file binding "${context.bindingName}" contains an array hole`
  );
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

function normalizeSupportedStaticCssPrimitiveLiteral(
  expression: t.Expression
): t.Expression {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

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
  const dynamicDiagnostic = createUnsupportedDynamicExpressionDiagnostic(
    context,
    expression
  );

  if (dynamicDiagnostic) {
    return dynamicDiagnostic;
  }

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
  detail: string,
  id?: StaticCssEvalDiagnostic["id"]
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    ...(id !== undefined ? { id } : {}),
    code,
    reason,
    detail,
    owner: context.owner,
    ...(context.memberPath.length > 0 ? { memberPath: context.memberPath } : {})
  });
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  const ownerFile = "/project/src/App.tsx";

  function resolveSameFileFixture(
    source: string
  ): SameFileStaticCssEvalResult[] {
    const results: SameFileStaticCssEvalResult[] = [];
    const result = transformSync(source, {
      filename: ownerFile,
      ast: true,
      code: false,
      sourceType: "module",
      configFile: false,
      babelrc: false,
      parserOpts: {
        plugins: ["jsx", "typescript"]
      },
      plugins: [
        function sameFileStaticCssEvalFixturePlugin(): PluginObj {
          return {
            visitor: {
              Program(programPath) {
                programPath.traverse({
                  JSXAttribute(attributePath) {
                    const expression = getCssFixtureExpression(
                      attributePath.node
                    );

                    if (!expression) {
                      return;
                    }

                    results.push(
                      resolveSameFileStaticCssEvalExpression({
                        expression,
                        ownerFile,
                        programPath,
                        scope: attributePath.scope
                      })
                    );
                  }
                });
              }
            }
          };
        }
      ]
    });

    if (result === null) {
      throw new Error("Failed to parse same-file static css eval fixture");
    }

    return results;
  }

  function getCssFixtureExpression(
    attribute: t.JSXAttribute
  ): t.Expression | null {
    if (!t.isJSXIdentifier(attribute.name) || attribute.name.name !== "css") {
      return null;
    }

    if (!t.isJSXExpressionContainer(attribute.value)) {
      return null;
    }

    const { expression } = attribute.value;

    return t.isJSXEmptyExpression(expression) ? null : expression;
  }

  function expectSingleResolved(
    source: string
  ): Extract<SameFileStaticCssEvalResult, { kind: "resolved" }> {
    const [result] = resolveSameFileFixture(source);
    expect(result?.kind).toBe("resolved");

    if (!result || result.kind !== "resolved") {
      throw new Error("Expected same-file fixture to resolve");
    }

    return result;
  }

  function expectSingleNotCandidate(
    source: string
  ): Extract<SameFileStaticCssEvalResult, { kind: "not-candidate" }> {
    const [result] = resolveSameFileFixture(source);
    expect(result?.kind).toBe("not-candidate");

    if (!result || result.kind !== "not-candidate") {
      throw new Error("Expected same-file fixture to remain a class value");
    }

    return result;
  }

  function expectSingleDiagnosticId(
    source: string,
    diagnosticId: NonNullable<StaticCssEvalDiagnostic["id"]>
  ): void {
    const [result] = resolveSameFileFixture(source);
    const diagnostic =
      result?.kind === "error" ||
      (result?.kind === "not-candidate" && result.status === "unsupported")
        ? result.diagnostic
        : undefined;
    const diagnostics =
      result?.kind === "error" ||
      (result?.kind === "not-candidate" && result.status === "unsupported")
        ? result.diagnostics
        : undefined;

    if (!diagnostic || !diagnostics) {
      throw new Error("Expected same-file fixture to return a diagnostic");
    }

    expect(diagnostic.id).toBe(diagnosticId);
    expect(diagnostics.map((item) => item.id)).toEqual([diagnosticId]);
  }

  function getStringObjectProperty(
    expression: t.ObjectExpression | t.ArrayExpression,
    propertyName: string
  ): string | null {
    const value = getObjectPropertyExpression(expression, propertyName);

    return value && t.isStringLiteral(value) ? value.value : null;
  }

  function getNumericObjectProperty(
    expression: t.ObjectExpression | t.ArrayExpression,
    propertyName: string
  ): number | null {
    const value = getObjectPropertyExpression(expression, propertyName);

    return value && t.isNumericLiteral(value) ? value.value : null;
  }

  function getObjectPropertyExpression(
    expression: t.ObjectExpression | t.ArrayExpression,
    propertyName: string
  ): t.Expression | null {
    if (!t.isObjectExpression(expression)) {
      return null;
    }

    for (let index = expression.properties.length - 1; index >= 0; index -= 1) {
      const property = expression.properties[index];

      if (!t.isObjectProperty(property) || property.computed) {
        continue;
      }

      if (getStaticObjectPropertyName(property.key) !== propertyName) {
        continue;
      }

      return t.isExpression(property.value) ? property.value : null;
    }

    return null;
  }

  function expectNoSpreadElement(
    expression: t.ObjectExpression | t.ArrayExpression
  ): void {
    if (t.isObjectExpression(expression)) {
      expect(
        expression.properties.some((property) => t.isSpreadElement(property))
      ).toBe(false);
      return;
    }

    expect(
      expression.elements.some((element) =>
        Boolean(element && t.isSpreadElement(element))
      )
    ).toBe(false);
  }

  describe("same-file static css eval resolver", () => {
    it("keeps top-level primitive identifiers as class values", () => {
      const result = expectSingleNotCandidate(`
        const className = "btn-primary";
        function App() {
          return <button css={className} />;
        }
      `);

      expect(result.status).toBeUndefined();
    });

    it("resolves local const objects with local provenance and dependencies", () => {
      const resolved = expectSingleResolved(`
        const button = { color: "red" };
        function App() {
          return <button css={button} />;
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe("red");
      expect(resolved).toMatchObject({
        status: "resolved",
        provenance: {
          kind: "local",
          file: ownerFile,
          bindingName: "button",
          declarationKind: "const"
        },
        dependencies: [
          {
            file: ownerFile,
            kind: "local",
            importer: ownerFile,
            specifier: "<local>",
            exportName: "button",
            memberPath: [],
            inspected: true,
            contributed: true
          }
        ],
        resolutionChain: [
          {
            importer: ownerFile,
            source: ownerFile,
            exportName: "button",
            memberPath: []
          }
        ],
        diagnostics: []
      });
    });

    it("resolves local object spreads with last-key-wins semantics", () => {
      const resolved = expectSingleResolved(`
        const base = { color: "red", padding: 4 };
        const button = { ...base, color: "blue" };
        function App() {
          return <button css={button} />;
        }
      `);

      expectNoSpreadElement(resolved.expression);
      expect(
        t.isObjectExpression(resolved.expression)
          ? resolved.expression.properties.filter(
              (property) =>
                t.isObjectProperty(property) &&
                !property.computed &&
                getStaticObjectPropertyName(property.key) === "color"
            )
          : []
      ).toHaveLength(1);
      expect(getStringObjectProperty(resolved.expression, "color")).toBe(
        "blue"
      );
      expect(getNumericObjectProperty(resolved.expression, "padding")).toBe(4);
    });

    it("resolves direct object spreads through the same-file resolver API", () => {
      const resolved = expectSingleResolved(`
        const base = { color: "red", padding: 4 };
        function App() {
          return <button css={{ ...base, color: "blue" }} />;
        }
      `);

      expectNoSpreadElement(resolved.expression);
      expect(getStringObjectProperty(resolved.expression, "color")).toBe(
        "blue"
      );
      expect(getNumericObjectProperty(resolved.expression, "padding")).toBe(4);
    });

    it("resolves local array spreads in order", () => {
      const resolved = expectSingleResolved(`
        const stack = [{ display: "grid" }];
        const rule = [...stack, { gap: 8 }];
        function App() {
          return <button css={rule} />;
        }
      `);

      expectNoSpreadElement(resolved.expression);
      expect(t.isArrayExpression(resolved.expression)).toBe(true);

      if (!t.isArrayExpression(resolved.expression)) {
        throw new Error(
          "Expected same-file array spread to resolve to an array"
        );
      }

      expect(resolved.expression.elements).toHaveLength(2);
      const [firstRule, secondRule] = resolved.expression.elements;
      expect(
        firstRule && t.isObjectExpression(firstRule)
          ? getStringObjectProperty(firstRule, "display")
          : null
      ).toBe("grid");
      expect(
        secondRule && t.isObjectExpression(secondRule)
          ? getNumericObjectProperty(secondRule, "gap")
          : null
      ).toBe(8);
    });

    it("resolves direct array spreads through the same-file resolver API", () => {
      const resolved = expectSingleResolved(`
        const stack = [{ display: "grid" }];
        function App() {
          return <button css={[...stack, { gap: 8 }]} />;
        }
      `);

      expectNoSpreadElement(resolved.expression);
      expect(t.isArrayExpression(resolved.expression)).toBe(true);

      if (!t.isArrayExpression(resolved.expression)) {
        throw new Error(
          "Expected direct same-file array spread to resolve to an array"
        );
      }

      expect(resolved.expression.elements).toHaveLength(2);
      const [firstRule, secondRule] = resolved.expression.elements;
      expect(
        firstRule && t.isObjectExpression(firstRule)
          ? getStringObjectProperty(firstRule, "display")
          : null
      ).toBe("grid");
      expect(
        secondRule && t.isObjectExpression(secondRule)
          ? getNumericObjectProperty(secondRule, "gap")
          : null
      ).toBe(8);
    });

    it("resolves local identifier and member values inside object literals", () => {
      const resolved = expectSingleResolved(`
        const color = "red";
        const tokens = { primary: "blue" };
        const button = { color, backgroundColor: tokens.primary };
        function App() {
          return <button css={button} />;
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe("red");
      expect(
        getStringObjectProperty(resolved.expression, "backgroundColor")
      ).toBe("blue");
    });

    it("resolves safe local aliases through transparent TypeScript wrappers", () => {
      const resolved = expectSingleResolved(`
        const base = ({ color: "red" } as const)!;
        const button = (base satisfies unknown)!;
        function App() {
          return <button css={button} />;
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe("red");
      expect(resolved.resolutionChain.map((entry) => entry.exportName)).toEqual(
        ["button", "base"]
      );
      expect(
        resolved.dependencies.map((dependency) => dependency.exportName)
      ).toEqual(["button", "base"]);
    });

    it("resolves local shadowing before imported bindings with the same name", () => {
      const resolved = expectSingleResolved(`
        import { button } from "./styles";
        function App() {
          const button = { color: "local" } as const;
          return <button css={button} />;
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe(
        "local"
      );
      expect(resolved.provenance).toMatchObject({
        kind: "local",
        file: ownerFile,
        bindingName: "button"
      });
    });

    it("records literal member paths in local resolution metadata", () => {
      const resolved = expectSingleResolved(`
        const styles = {
          buttons: {
            primary: { color: "red" }
          }
        } as const;
        function App() {
          return <button css={styles.buttons.primary} />;
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe("red");
      expect(resolved.dependencies[0]?.memberPath).toEqual([
        "buttons",
        "primary"
      ]);
      expect(resolved.resolutionChain[0]?.memberPath).toEqual([
        "buttons",
        "primary"
      ]);
    });

    it("returns exact diagnostics for unsafe same-file bindings", () => {
      expectSingleDiagnosticId(
        `
          let button = { color: "red" };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_MUTABLE_BINDING"
      );
      expectSingleDiagnosticId(
        `
          const button = { color: "red" };
          button.color = "blue";
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_MUTATED_BINDING"
      );
      expectSingleDiagnosticId(
        `
          const styles = { button: { color: "red" } };
          const variant = "button";
          function App() {
            return <button css={styles[variant]} />;
          }
        `,
        "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED"
      );
      expectSingleDiagnosticId(
        `
          const styles = { button: { color: "red" } };
          function App() {
            return <button css={styles?.button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
      expectSingleDiagnosticId(
        `
          const button = { color: getColor() };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
    });

    it("rejects unsafe spread operands deterministically", () => {
      expectSingleDiagnosticId(
        `
          const base = [{ color: "red" }];
          const button = { ...base };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED"
      );
      expectSingleDiagnosticId(
        `
          const base = { color: "red" };
          const rule = [...base];
          function App() {
            return <button css={rule} />;
          }
        `,
        "STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED"
      );
      expectSingleDiagnosticId(
        `
          let base = { color: "red" };
          const button = { ...base };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_MUTABLE_BINDING"
      );
      expectSingleDiagnosticId(
        `
          const base = { color: "red" };
          base.color = "blue";
          const button = { ...base };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_MUTATED_BINDING"
      );
    });

    it("rejects computed and optional member values deterministically", () => {
      expectSingleDiagnosticId(
        `
          const tokens = { primary: "red" };
          const tokenName = "primary";
          const button = { color: tokens[tokenName] };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED"
      );
      expectSingleDiagnosticId(
        `
          const tokens = { primary: "red" };
          const button = { color: tokens?.primary };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
    });

    it("rejects function values and calls deterministically", () => {
      expectSingleDiagnosticId(
        `
          const button = { color: getColor() };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
      expectSingleDiagnosticId(
        `
          const button = { color: () => "red" };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
    });

    it("guards local alias cycles deterministically", () => {
      expectSingleDiagnosticId(
        `
          const button = base;
          const base = button;
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_LOCAL_ALIAS_CYCLE"
      );
    });

    it("distinguishes shadowed aliases with the same name", () => {
      const resolved = expectSingleResolved(`
        const leaf = { color: "red" };
        const value = leaf;
        function App() {
          {
            const leaf = value;
            return <button css={leaf} />;
          }
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe("red");
    });
  });
}
