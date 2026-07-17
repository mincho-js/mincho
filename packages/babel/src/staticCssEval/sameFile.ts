import { transformSync, types as t } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";
import type { Binding, Scope } from "@babel/traverse";
import {
  getStaticMemberPropertyName,
  getStaticObjectMemberValue,
  getStaticObjectPropertyName,
  getUnsupportedLiteralReason
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

  const validationDiagnostic = validateStaticCssLiteralExpression(
    resolvedExpression,
    context,
    { count: 0 },
    1
  );

  if (validationDiagnostic) {
    return createSameFileErrorResult(
      validationDiagnostic,
      bindingResolution.metadata
    );
  }

  return {
    kind: "resolved",
    status: "resolved",
    expression: normalizeStaticCssLiteralExpression(resolvedExpression),
    provenance: bindingResolution.metadata.provenance,
    dependencies: bindingResolution.metadata.dependencies,
    resolutionChain: bindingResolution.metadata.resolutionChain,
    diagnostics: []
  };
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
      return createStaticCssEvalObjectSpreadUnsupportedDiagnostic(
        createSameFileDiagnosticContext(context),
        context.bindingName,
        "object"
      );
    }

    if (!t.isObjectProperty(property)) {
      return createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
        createSameFileDiagnosticContext(context),
        property.type
      );
    }

    if (property.computed) {
      return createStaticCssEvalComputedMemberUnsupportedDiagnostic(
        createSameFileDiagnosticContext(context)
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
      return createStaticCssEvalObjectSpreadUnsupportedDiagnostic(
        createSameFileDiagnosticContext(context),
        context.bindingName,
        "array"
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

if (import.meta.vitest) {
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
    if (!t.isObjectExpression(expression)) {
      return null;
    }

    for (const property of expression.properties) {
      if (!t.isObjectProperty(property) || property.computed) {
        continue;
      }

      if (getStaticObjectPropertyName(property.key) !== propertyName) {
        continue;
      }

      return t.isStringLiteral(property.value) ? property.value.value : null;
    }

    return null;
  }

  describe("same-file static css eval resolver", () => {
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
          const base = { color: "red" };
          const button = { ...base };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED"
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
