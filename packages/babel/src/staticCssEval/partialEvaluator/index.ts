import { transformSync, types as t } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";
import type { Binding, Scope } from "@babel/traverse";
import { unwrapTransparentCssRuleExpression } from "../candidates.js";
import { hasStaticCssEvalBindingMutation } from "../sameFile/mutation.js";
import {
  getStaticCssEvalBindingDeclarationKind,
  getStaticCssEvalVariableBindingInitExpression
} from "../sameFile/shapes.js";
import {
  STATIC_CSS_EVAL_LIMITS,
  type BindingProvenance,
  type ResolutionChainEntry,
  type ResolutionDependency,
  type StaticCssEvalCacheKey,
  type StaticCssEvalDiagnostic,
  type StaticCssEvalDiagnosticCode,
  type StaticCssEvalSourceLocation
} from "../types.js";

export const PARTIAL_EVAL_DEOPT_REASONS = [
  "mutated-binding",
  "unsupported-import",
  "unsupported-call-expression",
  "non-static-object-key",
  "unsupported-spread",
  "unsupported-computed-member",
  "runtime-css-shape",
  "unsupported-template-interpolation",
  "cycle-detected",
  "depth-limit",
  "node-count-limit"
] as const;

export type PartialEvalDeoptReason =
  (typeof PARTIAL_EVAL_DEOPT_REASONS)[number];

export interface PartialEvalLimits {
  readonly maxDepth: number;
  readonly maxNodeCount: number;
  readonly maxBindingStackDepth: number;
}

export const PARTIAL_EVAL_DEFAULT_LIMITS = {
  maxDepth: STATIC_CSS_EVAL_LIMITS.maxObjectArrayRecursionDepth,
  maxNodeCount: STATIC_CSS_EVAL_LIMITS.maxStaticLiteralNodeCount,
  maxBindingStackDepth: STATIC_CSS_EVAL_LIMITS.maxObjectArrayRecursionDepth
} as const satisfies PartialEvalLimits;

export interface PartialEvalPolicy {
  readonly kind: "jsx-css-prop";
  readonly providerValueMode: "value-to-fresh-ast";
  readonly importedBindingMode: "provider-result-only";
  readonly callExpressionMode: "deopt";
  readonly runtimeCssShapeMode: "deopt";
}

export const JSX_CSS_PROP_PARTIAL_EVAL_POLICY = {
  kind: "jsx-css-prop",
  providerValueMode: "value-to-fresh-ast",
  importedBindingMode: "provider-result-only",
  callExpressionMode: "deopt",
  runtimeCssShapeMode: "deopt"
} as const satisfies PartialEvalPolicy;

export type PartialEvalDeoptPathSegment =
  | { readonly kind: "binding"; readonly name: string }
  | { readonly kind: "member"; readonly name: string }
  | { readonly kind: "object-property"; readonly name: string }
  | { readonly kind: "array-element"; readonly index: number }
  | { readonly kind: "spread" };

export type PartialEvalDeoptPath = readonly PartialEvalDeoptPathSegment[];

export interface PartialEvalMetadata {
  readonly provenance?: BindingProvenance;
  readonly dependencies: readonly ResolutionDependency[];
  readonly resolutionChain: readonly ResolutionChainEntry[];
  readonly diagnostics: readonly StaticCssEvalDiagnostic[];
  readonly cacheKey?: StaticCssEvalCacheKey;
}

export interface CreatePartialEvalMetadataOptions {
  readonly provenance?: BindingProvenance;
  readonly dependencies?: readonly ResolutionDependency[];
  readonly resolutionChain?: readonly ResolutionChainEntry[];
  readonly diagnostics?: readonly StaticCssEvalDiagnostic[];
  readonly cacheKey?: StaticCssEvalCacheKey;
}

export interface PartialEvalBindingFrame {
  readonly bindingName: string;
  readonly memberPath: readonly string[];
  readonly owner: StaticCssEvalSourceLocation;
}

export interface PartialEvalState {
  readonly depth: number;
  readonly nodeCount: number;
  readonly bindingStack: readonly PartialEvalBindingFrame[];
}

export interface PartialEvalContext {
  readonly owner: StaticCssEvalSourceLocation;
  readonly policy: PartialEvalPolicy;
  readonly limits: PartialEvalLimits;
  readonly state: PartialEvalState;
  readonly metadata: PartialEvalMetadata;
}

export interface CreatePartialEvalContextOptions {
  readonly owner: StaticCssEvalSourceLocation;
  readonly policy?: PartialEvalPolicy;
  readonly limits?: Partial<PartialEvalLimits>;
  readonly state?: Partial<PartialEvalState>;
  readonly metadata?: PartialEvalMetadata;
}

export interface PartialEvalOptions {
  readonly expression: t.Expression;
  readonly context: PartialEvalContext;
  readonly programPath?: NodePath<t.Program>;
  readonly scope?: Scope;
}

export interface PartialEvalDiagnostic {
  readonly code: StaticCssEvalDiagnosticCode;
  readonly reason: PartialEvalDeoptReason;
  readonly message: string;
  readonly owner: StaticCssEvalSourceLocation;
  readonly deoptPath?: PartialEvalDeoptPath;
  readonly bindingName?: string;
  readonly memberPath?: readonly string[];
}

export interface CreatePartialEvalDiagnosticOptions {
  readonly reason: PartialEvalDeoptReason;
  readonly owner: StaticCssEvalSourceLocation;
  readonly detail?: string;
  readonly deoptPath?: PartialEvalDeoptPath;
  readonly bindingName?: string;
  readonly memberPath?: readonly string[];
}

export type PartialEvalResult =
  | PartialEvalConfidentResult
  | PartialEvalDeoptResult;

export interface PartialEvalConfidentResult {
  readonly kind: "confident";
  readonly confident: true;
  readonly expression: t.Expression;
  readonly metadata: PartialEvalMetadata;
  readonly diagnostics: readonly PartialEvalDiagnostic[];
  readonly reason?: never;
  readonly diagnostic?: never;
}

export interface PartialEvalDeoptResult {
  readonly kind: "deopt";
  readonly confident: false;
  readonly originalExpression: t.Expression;
  readonly fallbackExpression: t.Expression;
  readonly reason: PartialEvalDeoptReason;
  readonly diagnostic: PartialEvalDiagnostic;
  readonly diagnostics: readonly PartialEvalDiagnostic[];
  readonly metadata: PartialEvalMetadata;
}

export interface CreatePartialEvalConfidentResultOptions {
  readonly expression: t.Expression;
  readonly metadata?: PartialEvalMetadata;
  readonly diagnostics?: readonly PartialEvalDiagnostic[];
}

export interface CreatePartialEvalDeoptResultOptions extends CreatePartialEvalDiagnosticOptions {
  readonly originalExpression: t.Expression;
  readonly fallbackExpression?: t.Expression;
  readonly diagnostic?: PartialEvalDiagnostic;
  readonly diagnostics?: readonly PartialEvalDiagnostic[];
  readonly metadata?: PartialEvalMetadata;
}

const PARTIAL_EVAL_DIAGNOSTIC_MESSAGE_PREFIX =
  "Cannot partially evaluate css prop value";

export function createPartialEvalMetadata(
  options: CreatePartialEvalMetadataOptions = {}
): PartialEvalMetadata {
  return {
    ...(options.provenance !== undefined
      ? { provenance: options.provenance }
      : {}),
    dependencies: [...(options.dependencies ?? [])],
    resolutionChain: [...(options.resolutionChain ?? [])],
    diagnostics: [...(options.diagnostics ?? [])],
    ...(options.cacheKey !== undefined ? { cacheKey: options.cacheKey } : {})
  };
}

export function createPartialEvalContext(
  options: CreatePartialEvalContextOptions
): PartialEvalContext {
  const bindingStack = options.state?.bindingStack ?? [];

  return {
    owner: clonePartialEvalSourceLocation(options.owner),
    policy: options.policy ?? JSX_CSS_PROP_PARTIAL_EVAL_POLICY,
    limits: {
      ...PARTIAL_EVAL_DEFAULT_LIMITS,
      ...(options.limits ?? {})
    },
    state: {
      depth: options.state?.depth ?? 0,
      nodeCount: options.state?.nodeCount ?? 0,
      bindingStack: bindingStack.map(clonePartialEvalBindingFrame)
    },
    metadata: options.metadata ?? createPartialEvalMetadata()
  };
}

export function createPartialEvalDiagnostic(
  options: CreatePartialEvalDiagnosticOptions
): PartialEvalDiagnostic {
  const detail = options.detail ?? formatPartialEvalDeoptReason(options.reason);

  return {
    code: getPartialEvalDeoptReasonDiagnosticCode(options.reason),
    reason: options.reason,
    message: `${PARTIAL_EVAL_DIAGNOSTIC_MESSAGE_PREFIX}: ${detail}`,
    owner: clonePartialEvalSourceLocation(options.owner),
    ...(options.deoptPath !== undefined
      ? { deoptPath: clonePartialEvalDeoptPath(options.deoptPath) }
      : {}),
    ...(options.bindingName !== undefined
      ? { bindingName: options.bindingName }
      : {}),
    ...(options.memberPath !== undefined
      ? { memberPath: [...options.memberPath] }
      : {})
  };
}

export function createPartialEvalConfidentResult(
  options: CreatePartialEvalConfidentResultOptions
): PartialEvalConfidentResult {
  return {
    kind: "confident",
    confident: true,
    expression: options.expression,
    metadata: options.metadata ?? createPartialEvalMetadata(),
    diagnostics: [...(options.diagnostics ?? [])]
  };
}

export function createPartialEvalDeoptResult(
  options: CreatePartialEvalDeoptResultOptions
): PartialEvalDeoptResult {
  const diagnostic = options.diagnostic ?? createPartialEvalDiagnostic(options);

  return {
    kind: "deopt",
    confident: false,
    originalExpression: options.originalExpression,
    fallbackExpression:
      options.fallbackExpression ?? options.originalExpression,
    reason: options.reason,
    diagnostic,
    diagnostics: [diagnostic, ...(options.diagnostics ?? [])],
    metadata: options.metadata ?? createPartialEvalMetadata()
  };
}

export function getPartialEvalResultExpression(
  result: PartialEvalResult
): t.Expression {
  switch (result.kind) {
    case "confident":
      return result.expression;
    case "deopt":
      return result.fallbackExpression;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

type PartialEvalStaticPrimitive = string | number | boolean | null;

type PartialEvalPrimitiveFoldResult =
  | { readonly kind: "folded"; readonly value: PartialEvalStaticPrimitive }
  | { readonly kind: "unsupported" };

type PartialEvalDeoptDetails = Pick<
  CreatePartialEvalDiagnosticOptions,
  "bindingName" | "deoptPath" | "detail" | "memberPath"
> & {
  readonly fallbackExpression?: t.Expression;
};

type PendingPartialEvalDeopt = {
  readonly reason: PartialEvalDeoptReason;
  readonly details: PartialEvalDeoptDetails;
};

interface PartialEvalReductionContext {
  readonly bindingStack: readonly PartialEvalBindingFrame[];
  readonly programPath?: NodePath<t.Program>;
  readonly scope?: Scope;
}

type PartialEvalStringOrNumberMemberName = string | number;

type PartialEvalStaticNameResult =
  | { readonly kind: "resolved"; readonly name: string }
  | { readonly kind: "deopt"; readonly result: PartialEvalDeoptResult };

export function reducePartialEvalExpression(
  options: PartialEvalOptions
): PartialEvalResult {
  let visitedNodeCount = options.context.state.nodeCount;
  const initialReductionContext: PartialEvalReductionContext = {
    bindingStack: options.context.state.bindingStack,
    ...(options.programPath !== undefined
      ? { programPath: options.programPath }
      : {}),
    ...(options.scope !== undefined ? { scope: options.scope } : {})
  };

  function createConfidentResult(
    expression: t.Expression
  ): PartialEvalConfidentResult {
    return createPartialEvalConfidentResult({
      expression,
      metadata: options.context.metadata
    });
  }

  function createDeoptResult(
    expression: t.Expression,
    reason: PartialEvalDeoptReason,
    details: PartialEvalDeoptDetails = {}
  ): PartialEvalDeoptResult {
    return createPartialEvalDeoptResult({
      originalExpression: expression,
      fallbackExpression: expression,
      reason,
      owner: options.context.owner,
      metadata: options.context.metadata,
      ...details
    });
  }

  function createDeoptFromChild(
    expression: t.Expression,
    result: PartialEvalDeoptResult,
    reason: PartialEvalDeoptReason = result.reason,
    fallbackExpression?: t.Expression
  ): PartialEvalDeoptResult {
    return createDeoptResult(expression, reason, {
      ...(result.diagnostic.bindingName !== undefined
        ? { bindingName: result.diagnostic.bindingName }
        : {}),
      ...(result.diagnostic.deoptPath !== undefined
        ? { deoptPath: result.diagnostic.deoptPath }
        : {}),
      ...(result.diagnostic.memberPath !== undefined
        ? { memberPath: result.diagnostic.memberPath }
        : {}),
      ...(fallbackExpression !== undefined ? { fallbackExpression } : {})
    });
  }

  function createPendingDeoptFromChild(
    result: PartialEvalDeoptResult,
    reason: PartialEvalDeoptReason = result.reason
  ): PendingPartialEvalDeopt {
    return {
      reason,
      details: {
        ...(result.diagnostic.bindingName !== undefined
          ? { bindingName: result.diagnostic.bindingName }
          : {}),
        ...(result.diagnostic.deoptPath !== undefined
          ? { deoptPath: result.diagnostic.deoptPath }
          : {}),
        ...(result.diagnostic.memberPath !== undefined
          ? { memberPath: result.diagnostic.memberPath }
          : {})
      }
    };
  }

  function reduceExpression(
    expression: t.Expression,
    depth: number,
    reductionContext: PartialEvalReductionContext
  ): PartialEvalResult {
    visitedNodeCount += 1;

    if (visitedNodeCount > options.context.limits.maxNodeCount) {
      return createDeoptResult(expression, "node-count-limit");
    }

    if (depth > options.context.limits.maxDepth) {
      return createDeoptResult(expression, "depth-limit");
    }

    const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

    if (t.isUnaryExpression(unwrappedExpression)) {
      return reduceUnaryExpression(
        expression,
        unwrappedExpression,
        depth,
        reductionContext
      );
    }

    if (isStaticPrimitiveLiteralExpression(unwrappedExpression)) {
      return createConfidentResult(t.cloneNode(unwrappedExpression));
    }

    if (t.isTemplateLiteral(unwrappedExpression)) {
      return reduceTemplateLiteral(
        expression,
        unwrappedExpression,
        depth,
        reductionContext
      );
    }

    if (t.isObjectExpression(unwrappedExpression)) {
      return reduceObjectExpression(
        expression,
        unwrappedExpression,
        depth,
        reductionContext
      );
    }

    if (t.isArrayExpression(unwrappedExpression)) {
      return reduceArrayExpression(
        expression,
        unwrappedExpression,
        depth,
        reductionContext
      );
    }

    if (
      t.isMemberExpression(unwrappedExpression) ||
      t.isOptionalMemberExpression(unwrappedExpression)
    ) {
      return reduceMemberExpression(
        expression,
        unwrappedExpression,
        depth,
        reductionContext
      );
    }

    if (t.isIdentifier(unwrappedExpression)) {
      return reduceIdentifierExpression(
        expression,
        unwrappedExpression,
        depth,
        reductionContext
      );
    }

    if (t.isBinaryExpression(unwrappedExpression)) {
      return reduceBinaryExpression(
        expression,
        unwrappedExpression,
        depth,
        reductionContext
      );
    }

    if (t.isLogicalExpression(unwrappedExpression)) {
      return reduceLogicalExpression(
        expression,
        unwrappedExpression,
        depth,
        reductionContext
      );
    }

    if (
      t.isCallExpression(unwrappedExpression) ||
      t.isOptionalCallExpression(unwrappedExpression) ||
      t.isNewExpression(unwrappedExpression)
    ) {
      return createDeoptResult(expression, "unsupported-call-expression");
    }

    return createDeoptResult(expression, "runtime-css-shape");
  }

  function reduceTemplateLiteral(
    expression: t.Expression,
    templateLiteral: t.TemplateLiteral,
    depth: number,
    reductionContext: PartialEvalReductionContext
  ): PartialEvalResult {
    let value = "";

    for (let index = 0; index < templateLiteral.quasis.length; index += 1) {
      const quasi = templateLiteral.quasis[index];

      if (!quasi) {
        continue;
      }

      value += quasi.value.cooked ?? quasi.value.raw;

      const interpolation = templateLiteral.expressions[index];

      if (!interpolation) {
        continue;
      }

      if (!t.isExpression(interpolation)) {
        return createDeoptResult(
          expression,
          "unsupported-template-interpolation"
        );
      }

      const interpolationResult = reduceExpression(
        interpolation,
        depth + 1,
        reductionContext
      );

      if (interpolationResult.kind === "deopt") {
        return createDeoptFromChild(
          expression,
          interpolationResult,
          interpolationResult.reason === "unsupported-call-expression"
            ? "unsupported-call-expression"
            : getContextualDeoptReason(
                interpolationResult,
                "unsupported-template-interpolation"
              )
        );
      }

      const primitiveValue = getStaticPrimitiveValue(
        interpolationResult.expression
      );

      if (primitiveValue === undefined) {
        return createDeoptResult(
          expression,
          "unsupported-template-interpolation"
        );
      }

      value += String(primitiveValue);
    }

    return createConfidentResult(t.stringLiteral(value));
  }

  function reduceObjectExpression(
    expression: t.Expression,
    objectExpression: t.ObjectExpression,
    depth: number,
    reductionContext: PartialEvalReductionContext
  ): PartialEvalResult {
    const properties: t.ObjectExpression["properties"] = [];
    const propertyKeyIndexes = new Map<string, number>();
    let pendingDeopt: PendingPartialEvalDeopt | null = null;

    for (const property of objectExpression.properties) {
      if (t.isSpreadElement(property)) {
        const spreadResult = reduceExpression(
          property.argument,
          depth + 1,
          reductionContext
        );

        if (spreadResult.kind === "deopt") {
          pendingDeopt ??= createPendingDeoptFromChild(
            spreadResult,
            getContextualDeoptReason(spreadResult, "unsupported-spread")
          );
          properties.push(
            t.spreadElement(t.cloneNode(spreadResult.fallbackExpression))
          );
          continue;
        }

        const spreadExpression = unwrapTransparentCssRuleExpression(
          spreadResult.expression
        );

        if (!t.isObjectExpression(spreadExpression)) {
          pendingDeopt ??= {
            reason: "unsupported-spread",
            details: { deoptPath: [{ kind: "spread" }] }
          };
          properties.push(t.cloneNode(property));
          continue;
        }

        let hasNestedSpread = false;
        for (const spreadProperty of spreadExpression.properties) {
          if (t.isSpreadElement(spreadProperty)) {
            pendingDeopt ??= {
              reason: "unsupported-spread",
              details: { deoptPath: [{ kind: "spread" }] }
            };
            properties.push(t.cloneNode(property));
            hasNestedSpread = true;
            break;
          }

          pushObjectPropertyWithOverride(
            properties,
            t.cloneNode(spreadProperty),
            propertyKeyIndexes
          );
        }

        if (hasNestedSpread) {
          continue;
        }

        continue;
      }

      if (!t.isObjectProperty(property) || !t.isExpression(property.value)) {
        pendingDeopt ??= { reason: "runtime-css-shape", details: {} };
        properties.push(t.cloneNode(property));
        continue;
      }

      const keyResult = reduceObjectPropertyKey(
        expression,
        property,
        depth,
        reductionContext
      );

      if (keyResult.kind === "deopt") {
        pendingDeopt ??= createPendingDeoptFromChild(keyResult.result);
        properties.push(t.cloneNode(property));
        continue;
      }

      const valueResult = reduceExpression(
        property.value,
        depth + 1,
        reductionContext
      );

      const nextProperty = t.cloneNode(property);
      nextProperty.key = createStaticObjectPropertyKey(keyResult.name);
      nextProperty.computed = false;
      nextProperty.shorthand = false;

      if (valueResult.kind === "deopt") {
        pendingDeopt ??= createPendingDeoptFromChild(valueResult);
        nextProperty.value = t.cloneNode(valueResult.fallbackExpression);
        properties.push(nextProperty);
        continue;
      }

      nextProperty.value = valueResult.expression;
      pushObjectPropertyWithOverride(
        properties,
        nextProperty,
        propertyKeyIndexes
      );
    }

    const reducedExpression = t.objectExpression(properties);

    return pendingDeopt
      ? createDeoptResult(expression, pendingDeopt.reason, {
          ...pendingDeopt.details,
          fallbackExpression: reducedExpression
        })
      : createConfidentResult(reducedExpression);
  }

  function pushObjectPropertyWithOverride(
    properties: t.ObjectExpression["properties"],
    property: t.ObjectExpression["properties"][number],
    propertyKeyIndexes: Map<string, number>
  ): void {
    const keyName = t.isObjectProperty(property)
      ? getStaticObjectPropertyName(property.key)
      : null;

    if (keyName) {
      const existingIndex = propertyKeyIndexes.get(keyName);

      if (existingIndex !== undefined) {
        properties[existingIndex] = property;
        return;
      }

      propertyKeyIndexes.set(keyName, properties.length);
    }

    properties.push(property);
  }

  function reduceArrayExpression(
    expression: t.Expression,
    arrayExpression: t.ArrayExpression,
    depth: number,
    reductionContext: PartialEvalReductionContext
  ): PartialEvalResult {
    const elements: t.ArrayExpression["elements"] = [];
    let pendingDeopt: PendingPartialEvalDeopt | null = null;

    for (const element of arrayExpression.elements) {
      if (!element) {
        pendingDeopt ??= { reason: "runtime-css-shape", details: {} };
        elements.push(null);
        continue;
      }

      if (t.isSpreadElement(element)) {
        const spreadResult = reduceExpression(
          element.argument,
          depth + 1,
          reductionContext
        );

        if (spreadResult.kind === "deopt") {
          pendingDeopt ??= createPendingDeoptFromChild(
            spreadResult,
            getContextualDeoptReason(spreadResult, "unsupported-spread")
          );
          elements.push(
            t.spreadElement(t.cloneNode(spreadResult.fallbackExpression))
          );
          continue;
        }

        const spreadExpression = unwrapTransparentCssRuleExpression(
          spreadResult.expression
        );

        if (!t.isArrayExpression(spreadExpression)) {
          pendingDeopt ??= {
            reason: "unsupported-spread",
            details: { deoptPath: [{ kind: "spread" }] }
          };
          elements.push(t.cloneNode(element));
          continue;
        }

        let hasNestedSpread = false;
        for (const spreadElement of spreadExpression.elements) {
          if (!spreadElement || t.isSpreadElement(spreadElement)) {
            pendingDeopt ??= {
              reason: "unsupported-spread",
              details: { deoptPath: [{ kind: "spread" }] }
            };
            elements.push(t.cloneNode(element));
            hasNestedSpread = true;
            break;
          }

          elements.push(t.cloneNode(spreadElement));
        }

        if (hasNestedSpread) {
          continue;
        }

        continue;
      }

      const elementResult = reduceExpression(
        element,
        depth + 1,
        reductionContext
      );

      if (elementResult.kind === "deopt") {
        pendingDeopt ??= createPendingDeoptFromChild(elementResult);
        elements.push(t.cloneNode(elementResult.fallbackExpression));
        continue;
      }

      elements.push(elementResult.expression);
    }

    const reducedExpression = t.arrayExpression(elements);

    return pendingDeopt
      ? createDeoptResult(expression, pendingDeopt.reason, {
          ...pendingDeopt.details,
          fallbackExpression: reducedExpression
        })
      : createConfidentResult(reducedExpression);
  }

  function reduceMemberExpression(
    expression: t.Expression,
    memberExpression: t.MemberExpression | t.OptionalMemberExpression,
    depth: number,
    reductionContext: PartialEvalReductionContext
  ): PartialEvalResult {
    if (t.isOptionalMemberExpression(memberExpression)) {
      return createDeoptResult(expression, "unsupported-computed-member");
    }

    if (t.isSuper(memberExpression.object)) {
      return createDeoptResult(expression, "runtime-css-shape");
    }

    const objectResult = reduceExpression(
      memberExpression.object,
      depth + 1,
      reductionContext
    );

    if (objectResult.kind === "deopt") {
      return createDeoptFromChild(expression, objectResult);
    }

    const nameResult = reduceMemberName(
      memberExpression,
      depth,
      reductionContext
    );

    if (nameResult.kind === "deopt") {
      return createDeoptFromChild(expression, nameResult.result);
    }

    const target = unwrapTransparentCssRuleExpression(objectResult.expression);
    const memberValue = t.isObjectExpression(target)
      ? getStaticObjectMemberValue(target, nameResult.name)
      : t.isArrayExpression(target)
        ? getStaticArrayMemberValue(target, nameResult.name)
        : null;

    return memberValue
      ? createConfidentResult(t.cloneNode(memberValue))
      : createDeoptResult(expression, "runtime-css-shape");
  }

  function reduceIdentifierExpression(
    expression: t.Expression,
    identifier: t.Identifier,
    depth: number,
    reductionContext: PartialEvalReductionContext
  ): PartialEvalResult {
    if (!reductionContext.scope || !reductionContext.programPath) {
      return createDeoptResult(expression, "runtime-css-shape");
    }

    const binding = reductionContext.scope.getBinding(identifier.name);

    if (!binding) {
      return createDeoptResult(expression, "runtime-css-shape");
    }

    const bindingDeoptPath: PartialEvalDeoptPath = [
      { kind: "binding", name: identifier.name }
    ];

    if (isImportedBinding(binding)) {
      return createDeoptResult(expression, "unsupported-import", {
        bindingName: identifier.name,
        deoptPath: bindingDeoptPath
      });
    }

    const declarationKind = getStaticCssEvalBindingDeclarationKind(binding);
    const init = getStaticCssEvalVariableBindingInitExpression(binding);

    if (!declarationKind || !init) {
      return createDeoptResult(expression, "runtime-css-shape", {
        bindingName: identifier.name,
        deoptPath: bindingDeoptPath
      });
    }

    if (declarationKind === "let" || declarationKind === "var") {
      return createDeoptResult(expression, "mutated-binding", {
        bindingName: identifier.name,
        deoptPath: bindingDeoptPath,
        detail: `same-file binding "${identifier.name}" is mutated`
      });
    }

    if (declarationKind !== "const") {
      return createDeoptResult(expression, "runtime-css-shape", {
        bindingName: identifier.name,
        deoptPath: bindingDeoptPath
      });
    }

    const currentFrame: PartialEvalBindingFrame = {
      bindingName: identifier.name,
      memberPath: [],
      owner: options.context.owner
    };

    if (hasBindingStackCycle(reductionContext.bindingStack, currentFrame)) {
      return createDeoptResult(expression, "cycle-detected", {
        bindingName: identifier.name,
        deoptPath: bindingDeoptPath
      });
    }

    const nextBindingStack = [...reductionContext.bindingStack, currentFrame];

    if (nextBindingStack.length > options.context.limits.maxBindingStackDepth) {
      return createDeoptResult(expression, "depth-limit", {
        bindingName: identifier.name,
        deoptPath: bindingDeoptPath
      });
    }

    if (
      hasStaticCssEvalBindingMutation(reductionContext.programPath, binding)
    ) {
      return createDeoptResult(expression, "mutated-binding", {
        bindingName: identifier.name,
        deoptPath: bindingDeoptPath,
        detail: `same-file binding "${identifier.name}" is mutated`
      });
    }

    return reduceExpression(init, depth + 1, {
      ...reductionContext,
      bindingStack: nextBindingStack,
      scope: binding.scope
    });
  }

  function reduceObjectPropertyKey(
    expression: t.Expression,
    property: t.ObjectProperty,
    depth: number,
    reductionContext: PartialEvalReductionContext
  ): PartialEvalStaticNameResult {
    const staticName = getStaticObjectPropertyName(property.key);

    if (!property.computed) {
      return staticName
        ? { kind: "resolved", name: staticName }
        : {
            kind: "deopt",
            result: createDeoptResult(expression, "non-static-object-key")
          };
    }

    if (!t.isExpression(property.key)) {
      return {
        kind: "deopt",
        result: createDeoptResult(expression, "non-static-object-key")
      };
    }

    const keyResult = reduceExpression(
      property.key,
      depth + 1,
      reductionContext
    );

    if (keyResult.kind === "deopt") {
      return {
        kind: "deopt",
        result: createDeoptFromChild(
          expression,
          keyResult,
          getContextualDeoptReason(keyResult, "non-static-object-key")
        )
      };
    }

    const keyName = getStaticStringOrNumberMemberName(keyResult.expression);

    return keyName === null
      ? {
          kind: "deopt",
          result: createDeoptResult(expression, "non-static-object-key")
        }
      : { kind: "resolved", name: String(keyName) };
  }

  function reduceMemberName(
    memberExpression: t.MemberExpression,
    depth: number,
    reductionContext: PartialEvalReductionContext
  ): PartialEvalStaticNameResult {
    if (
      !memberExpression.computed &&
      t.isIdentifier(memberExpression.property)
    ) {
      return { kind: "resolved", name: memberExpression.property.name };
    }

    if (!t.isExpression(memberExpression.property)) {
      return {
        kind: "deopt",
        result: createDeoptResult(
          memberExpression,
          "unsupported-computed-member"
        )
      };
    }

    const keyResult = reduceExpression(
      memberExpression.property,
      depth + 1,
      reductionContext
    );

    if (keyResult.kind === "deopt") {
      return {
        kind: "deopt",
        result: createDeoptFromChild(
          memberExpression,
          keyResult,
          getContextualDeoptReason(keyResult, "unsupported-computed-member")
        )
      };
    }

    const memberName = getStaticStringOrNumberMemberName(keyResult.expression);

    return memberName === null
      ? {
          kind: "deopt",
          result: createDeoptResult(
            memberExpression,
            "unsupported-computed-member"
          )
        }
      : { kind: "resolved", name: String(memberName) };
  }

  function reduceUnaryExpression(
    expression: t.Expression,
    unaryExpression: t.UnaryExpression,
    depth: number,
    reductionContext: PartialEvalReductionContext
  ): PartialEvalResult {
    const argumentResult = reduceExpression(
      unaryExpression.argument,
      depth + 1,
      reductionContext
    );

    if (argumentResult.kind === "deopt") {
      return createDeoptFromChild(expression, argumentResult);
    }

    const primitiveValue = getStaticPrimitiveValue(argumentResult.expression);

    if (primitiveValue === undefined) {
      return createDeoptResult(expression, "runtime-css-shape");
    }

    switch (unaryExpression.operator) {
      case "+":
        return typeof primitiveValue === "number"
          ? createConfidentResult(t.numericLiteral(primitiveValue))
          : createDeoptResult(expression, "runtime-css-shape");
      case "-":
        return typeof primitiveValue === "number"
          ? createConfidentResult(t.numericLiteral(-primitiveValue))
          : createDeoptResult(expression, "runtime-css-shape");
      case "!":
        return createConfidentResult(
          t.booleanLiteral(!isTruthyStaticPrimitive(primitiveValue))
        );
      default:
        return createDeoptResult(expression, "runtime-css-shape");
    }
  }

  function reduceBinaryExpression(
    expression: t.Expression,
    binaryExpression: t.BinaryExpression,
    depth: number,
    reductionContext: PartialEvalReductionContext
  ): PartialEvalResult {
    if (!t.isExpression(binaryExpression.left)) {
      return createDeoptResult(expression, "runtime-css-shape");
    }

    const leftResult = reduceExpression(
      binaryExpression.left,
      depth + 1,
      reductionContext
    );

    if (leftResult.kind === "deopt") {
      return createDeoptFromChild(expression, leftResult);
    }

    const rightResult = reduceExpression(
      binaryExpression.right,
      depth + 1,
      reductionContext
    );

    if (rightResult.kind === "deopt") {
      return createDeoptFromChild(expression, rightResult);
    }

    const leftValue = getStaticPrimitiveValue(leftResult.expression);
    const rightValue = getStaticPrimitiveValue(rightResult.expression);

    if (leftValue === undefined || rightValue === undefined) {
      return createDeoptResult(expression, "runtime-css-shape");
    }

    const foldResult = foldBinaryPrimitiveValue(
      binaryExpression.operator,
      leftValue,
      rightValue
    );

    return foldResult.kind === "folded"
      ? createConfidentResult(createStaticPrimitiveExpression(foldResult.value))
      : createDeoptResult(expression, "runtime-css-shape");
  }

  function reduceLogicalExpression(
    expression: t.Expression,
    logicalExpression: t.LogicalExpression,
    depth: number,
    reductionContext: PartialEvalReductionContext
  ): PartialEvalResult {
    const leftResult = reduceExpression(
      logicalExpression.left,
      depth + 1,
      reductionContext
    );

    if (leftResult.kind === "deopt") {
      return createDeoptFromChild(expression, leftResult);
    }

    const rightResult = reduceExpression(
      logicalExpression.right,
      depth + 1,
      reductionContext
    );

    if (rightResult.kind === "deopt") {
      return createDeoptFromChild(expression, rightResult);
    }

    const leftValue = getStaticPrimitiveValue(leftResult.expression);
    const rightValue = getStaticPrimitiveValue(rightResult.expression);

    if (leftValue === undefined || rightValue === undefined) {
      return createDeoptResult(expression, "runtime-css-shape");
    }

    switch (logicalExpression.operator) {
      case "&&":
        return createConfidentResult(
          t.cloneNode(
            isTruthyStaticPrimitive(leftValue)
              ? rightResult.expression
              : leftResult.expression
          )
        );
      case "||":
        return createConfidentResult(
          t.cloneNode(
            isTruthyStaticPrimitive(leftValue)
              ? leftResult.expression
              : rightResult.expression
          )
        );
      case "??":
        return createConfidentResult(
          t.cloneNode(
            leftValue === null ? rightResult.expression : leftResult.expression
          )
        );
      default: {
        const exhaustive: never = logicalExpression.operator;
        return exhaustive;
      }
    }
  }

  return reduceExpression(
    options.expression,
    options.context.state.depth,
    initialReductionContext
  );
}

function getContextualDeoptReason(
  result: PartialEvalDeoptResult,
  fallbackReason: PartialEvalDeoptReason
): PartialEvalDeoptReason {
  switch (result.reason) {
    case "mutated-binding":
    case "unsupported-import":
    case "cycle-detected":
    case "depth-limit":
    case "node-count-limit":
      return result.reason;
    case "unsupported-call-expression":
    case "non-static-object-key":
    case "unsupported-spread":
    case "unsupported-computed-member":
    case "runtime-css-shape":
    case "unsupported-template-interpolation":
      return fallbackReason;
    default: {
      const exhaustive: never = result.reason;
      return exhaustive;
    }
  }
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

function getStaticObjectMemberValue(
  expression: t.ObjectExpression,
  memberName: string
): t.Expression | null {
  for (let index = expression.properties.length - 1; index >= 0; index -= 1) {
    const property = expression.properties[index];

    if (!t.isObjectProperty(property) || property.computed) {
      return null;
    }

    if (getStaticObjectPropertyName(property.key) !== memberName) {
      continue;
    }

    return t.isExpression(property.value) ? property.value : null;
  }

  return null;
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

function getStaticObjectPropertyName(
  key: t.ObjectProperty["key"]
): string | null {
  if (t.isIdentifier(key)) {
    return key.name;
  }

  if (t.isStringLiteral(key)) {
    return key.value;
  }

  if (t.isNumericLiteral(key)) {
    return String(key.value);
  }

  return null;
}

function createStaticObjectPropertyKey(
  propertyName: string
): t.Identifier | t.StringLiteral {
  return t.isValidIdentifier(propertyName)
    ? t.identifier(propertyName)
    : t.stringLiteral(propertyName);
}

function getStaticStringOrNumberMemberName(
  expression: t.Expression
): PartialEvalStringOrNumberMemberName | null {
  const value = getStaticPrimitiveValue(expression);
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function isStaticPrimitiveLiteralExpression(
  expression: t.Expression
): expression is
  | t.StringLiteral
  | t.NumericLiteral
  | t.BooleanLiteral
  | t.NullLiteral {
  return (
    t.isStringLiteral(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBooleanLiteral(expression) ||
    t.isNullLiteral(expression)
  );
}

function getStaticPrimitiveValue(
  expression: t.Expression
): PartialEvalStaticPrimitive | undefined {
  if (t.isStringLiteral(expression)) {
    return expression.value;
  }

  if (t.isNumericLiteral(expression)) {
    return expression.value;
  }

  if (t.isBooleanLiteral(expression)) {
    return expression.value;
  }

  if (t.isNullLiteral(expression)) {
    return null;
  }

  return undefined;
}

function createStaticPrimitiveExpression(
  value: PartialEvalStaticPrimitive
): t.Expression {
  if (value === null) {
    return t.nullLiteral();
  }

  switch (typeof value) {
    case "string":
      return t.stringLiteral(value);
    case "number":
      return t.numericLiteral(value);
    case "boolean":
      return t.booleanLiteral(value);
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function isTruthyStaticPrimitive(value: PartialEvalStaticPrimitive): boolean {
  return !!value;
}

function foldBinaryPrimitiveValue(
  operator: t.BinaryExpression["operator"],
  leftValue: PartialEvalStaticPrimitive,
  rightValue: PartialEvalStaticPrimitive
): PartialEvalPrimitiveFoldResult {
  switch (operator) {
    case "+":
      if (typeof leftValue === "number" && typeof rightValue === "number") {
        return createFiniteNumberFoldResult(leftValue + rightValue);
      }

      if (typeof leftValue === "string" || typeof rightValue === "string") {
        return { kind: "folded", value: `${leftValue}${rightValue}` };
      }

      return { kind: "unsupported" };
    case "-":
      return foldNumberBinaryPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left - right
      );
    case "*":
      return foldNumberBinaryPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left * right
      );
    case "/":
      return foldNumberBinaryPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left / right
      );
    case "%":
      return foldNumberBinaryPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left % right
      );
    case "**":
      return foldNumberBinaryPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left ** right
      );
    case "<":
      return foldNumberComparisonPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left < right
      );
    case "<=":
      return foldNumberComparisonPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left <= right
      );
    case ">":
      return foldNumberComparisonPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left > right
      );
    case ">=":
      return foldNumberComparisonPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left >= right
      );
    case "===":
      return { kind: "folded", value: leftValue === rightValue };
    case "!==":
      return { kind: "folded", value: leftValue !== rightValue };
    case "==":
    case "!=":
    case "|":
    case "&":
    case "^":
    case "<<":
    case ">>":
    case ">>>":
    case "|>":
    case "in":
    case "instanceof":
      return { kind: "unsupported" };
    default: {
      const exhaustive: never = operator;
      return exhaustive;
    }
  }
}

function foldNumberBinaryPrimitiveValue(
  leftValue: PartialEvalStaticPrimitive,
  rightValue: PartialEvalStaticPrimitive,
  fold: (leftValue: number, rightValue: number) => number
): PartialEvalPrimitiveFoldResult {
  return typeof leftValue === "number" && typeof rightValue === "number"
    ? createFiniteNumberFoldResult(fold(leftValue, rightValue))
    : { kind: "unsupported" };
}

function foldNumberComparisonPrimitiveValue(
  leftValue: PartialEvalStaticPrimitive,
  rightValue: PartialEvalStaticPrimitive,
  fold: (leftValue: number, rightValue: number) => boolean
): PartialEvalPrimitiveFoldResult {
  return typeof leftValue === "number" && typeof rightValue === "number"
    ? { kind: "folded", value: fold(leftValue, rightValue) }
    : { kind: "unsupported" };
}

function createFiniteNumberFoldResult(
  value: number
): PartialEvalPrimitiveFoldResult {
  return Number.isFinite(value)
    ? { kind: "folded", value }
    : { kind: "unsupported" };
}

export function getPartialEvalDeoptReasonDiagnosticCode(
  reason: PartialEvalDeoptReason
): StaticCssEvalDiagnosticCode {
  switch (reason) {
    case "mutated-binding":
      return "mutation-detected";
    case "unsupported-import":
      return "unsupported-source";
    case "unsupported-call-expression":
    case "non-static-object-key":
    case "unsupported-spread":
    case "unsupported-computed-member":
    case "runtime-css-shape":
    case "unsupported-template-interpolation":
      return "unsupported-syntax";
    case "cycle-detected":
      return "cycle-detected";
    case "depth-limit":
    case "node-count-limit":
      return "limit-exceeded";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export function formatPartialEvalDeoptReason(
  reason: PartialEvalDeoptReason
): string {
  switch (reason) {
    case "mutated-binding":
      return "binding is mutated";
    case "unsupported-import":
      return "imported binding must be resolved by the static css provider";
    case "unsupported-call-expression":
      return "call expressions are not evaluated by Babel";
    case "non-static-object-key":
      return "object key is not statically known";
    case "unsupported-spread":
      return "spread operand is not statically reducible";
    case "unsupported-computed-member":
      return "computed member access is not statically known";
    case "runtime-css-shape":
      return "runtime css object shape is unsupported";
    case "unsupported-template-interpolation":
      return "template interpolation is not a static primitive";
    case "cycle-detected":
      return "binding cycle detected";
    case "depth-limit":
      return "partial evaluator depth limit exceeded";
    case "node-count-limit":
      return "partial evaluator node count limit exceeded";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function clonePartialEvalSourceLocation(
  owner: StaticCssEvalSourceLocation
): StaticCssEvalSourceLocation {
  return { ...owner };
}

function clonePartialEvalBindingFrame(
  frame: PartialEvalBindingFrame
): PartialEvalBindingFrame {
  return {
    bindingName: frame.bindingName,
    memberPath: [...frame.memberPath],
    owner: clonePartialEvalSourceLocation(frame.owner)
  };
}

function clonePartialEvalDeoptPath(
  path: PartialEvalDeoptPath
): PartialEvalDeoptPath {
  return path.map(clonePartialEvalDeoptPathSegment);
}

function clonePartialEvalDeoptPathSegment(
  segment: PartialEvalDeoptPathSegment
): PartialEvalDeoptPathSegment {
  switch (segment.kind) {
    case "binding":
    case "member":
    case "object-property":
      return { kind: segment.kind, name: segment.name };
    case "array-element":
      return { kind: segment.kind, index: segment.index };
    case "spread":
      return { kind: segment.kind };
    default: {
      const exhaustive: never = segment;
      return exhaustive;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  const owner: StaticCssEvalSourceLocation = {
    file: "/project/src/App.tsx",
    start: 42,
    end: 55
  };

  const requiredDeoptReasons = [
    "mutated-binding",
    "unsupported-import",
    "unsupported-call-expression",
    "non-static-object-key",
    "unsupported-spread",
    "unsupported-computed-member",
    "runtime-css-shape",
    "unsupported-template-interpolation",
    "cycle-detected",
    "depth-limit",
    "node-count-limit"
  ] as const satisfies readonly PartialEvalDeoptReason[];

  function createReasonExpression(
    reason: PartialEvalDeoptReason
  ): t.Expression {
    return t.identifier(reason.replaceAll("-", "_"));
  }

  function handleDeoptReasonForTest(reason: PartialEvalDeoptReason): string {
    switch (reason) {
      case "mutated-binding":
        return "mutation";
      case "unsupported-import":
        return "import";
      case "unsupported-call-expression":
        return "call";
      case "non-static-object-key":
        return "object-key";
      case "unsupported-spread":
        return "spread";
      case "unsupported-computed-member":
        return "computed-member";
      case "runtime-css-shape":
        return "runtime-shape";
      case "unsupported-template-interpolation":
        return "template";
      case "cycle-detected":
        return "cycle";
      case "depth-limit":
        return "depth";
      case "node-count-limit":
        return "node-count";
      default: {
        const exhaustive: never = reason;
        return exhaustive;
      }
    }
  }

  function reduceForTest(expression: t.Expression): PartialEvalResult {
    return reducePartialEvalExpression({
      expression,
      context: createPartialEvalContext({ owner })
    });
  }

  function expectConfidentExpression(result: PartialEvalResult): t.Expression {
    expect(result.kind).toBe("confident");

    if (result.kind !== "confident") {
      throw new Error(`expected confident result, got ${result.kind}`);
    }

    return result.expression;
  }

  function expectDeoptResult(
    result: PartialEvalResult
  ): PartialEvalDeoptResult {
    expect(result.kind).toBe("deopt");

    if (result.kind !== "deopt") {
      throw new Error(`expected deopt result, got ${result.kind}`);
    }

    return result;
  }

  function expectStringLiteralExpression(
    expression: t.Expression,
    value: string
  ): void {
    expect(t.isStringLiteral(expression)).toBe(true);

    if (!t.isStringLiteral(expression)) {
      throw new Error(`expected string literal, got ${expression.type}`);
    }

    expect(expression.value).toBe(value);
  }

  function expectNumericLiteralExpression(
    expression: t.Expression,
    value: number
  ): void {
    expect(t.isNumericLiteral(expression)).toBe(true);

    if (!t.isNumericLiteral(expression)) {
      throw new Error(`expected numeric literal, got ${expression.type}`);
    }

    expect(expression.value).toBe(value);
  }

  function expectBooleanLiteralExpression(
    expression: t.Expression,
    value: boolean
  ): void {
    expect(t.isBooleanLiteral(expression)).toBe(true);

    if (!t.isBooleanLiteral(expression)) {
      throw new Error(`expected boolean literal, got ${expression.type}`);
    }

    expect(expression.value).toBe(value);
  }

  function expectNullLiteralExpression(expression: t.Expression): void {
    expect(t.isNullLiteral(expression)).toBe(true);

    if (!t.isNullLiteral(expression)) {
      throw new Error(`expected null literal, got ${expression.type}`);
    }
  }

  function createTemplateElement(
    value: string,
    tail: boolean
  ): t.TemplateElement {
    return t.templateElement({ raw: value, cooked: value }, tail);
  }

  function reduceFixture(
    source: string,
    limits?: Partial<PartialEvalLimits>
  ): PartialEvalResult[] {
    const results: PartialEvalResult[] = [];
    const transformResult = transformSync(source, {
      filename: owner.file,
      ast: true,
      code: false,
      sourceType: "module",
      configFile: false,
      babelrc: false,
      parserOpts: {
        plugins: ["jsx", "typescript"]
      },
      plugins: [
        function partialEvaluatorFixturePlugin(): PluginObj {
          return {
            visitor: {
              Program(programPath) {
                programPath.traverse({
                  CallExpression(callPath) {
                    if (
                      !t.isIdentifier(callPath.node.callee, { name: "capture" })
                    ) {
                      return;
                    }

                    const [argument] = callPath.node.arguments;

                    if (!argument || !t.isExpression(argument)) {
                      return;
                    }

                    results.push(
                      reducePartialEvalExpression({
                        expression: argument,
                        context: createPartialEvalContext({ owner, limits }),
                        programPath,
                        scope: callPath.scope
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

    if (transformResult === null) {
      throw new Error("failed to parse partial evaluator fixture");
    }

    return results;
  }

  function expectFixtureConfidentExpression(
    results: readonly PartialEvalResult[],
    index: number
  ): t.Expression {
    const result = results[index];

    if (!result) {
      throw new Error(`expected fixture result at index ${index}`);
    }

    return expectConfidentExpression(result);
  }

  function expectFixtureDeoptResult(
    results: readonly PartialEvalResult[],
    index: number
  ): PartialEvalDeoptResult {
    const result = results[index];

    if (!result) {
      throw new Error(`expected fixture result at index ${index}`);
    }

    return expectDeoptResult(result);
  }

  function expectObjectExpression(
    expression: t.Expression
  ): t.ObjectExpression {
    expect(t.isObjectExpression(expression)).toBe(true);

    if (!t.isObjectExpression(expression)) {
      throw new Error(`expected object expression, got ${expression.type}`);
    }

    return expression;
  }

  function expectArrayExpression(expression: t.Expression): t.ArrayExpression {
    expect(t.isArrayExpression(expression)).toBe(true);

    if (!t.isArrayExpression(expression)) {
      throw new Error(`expected array expression, got ${expression.type}`);
    }

    return expression;
  }

  function expectArrayElementExpression(
    expression: t.ArrayExpression,
    index: number
  ): t.Expression {
    const element = expression.elements[index];

    if (!element || t.isSpreadElement(element)) {
      throw new Error(`expected array expression element at index ${index}`);
    }

    return element;
  }

  function expectObjectPropertyExpression(
    expression: t.ObjectExpression,
    propertyName: string
  ): t.Expression {
    for (let index = expression.properties.length - 1; index >= 0; index -= 1) {
      const property = expression.properties[index];

      if (!t.isObjectProperty(property) || property.computed) {
        continue;
      }

      if (getStaticObjectPropertyName(property.key) !== propertyName) {
        continue;
      }

      if (t.isExpression(property.value)) {
        return property.value;
      }
    }

    throw new Error(`expected object property ${propertyName}`);
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

  describe("partial evaluator result model", () => {
    it("creates confident and deopt result model helpers", () => {
      const expression = t.identifier("styles");
      const fallbackExpression = t.objectExpression([]);
      const context = createPartialEvalContext({
        owner,
        state: {
          depth: 1,
          nodeCount: 2,
          bindingStack: [
            {
              bindingName: "styles",
              memberPath: ["button"],
              owner
            }
          ]
        },
        limits: { maxDepth: 3 }
      });

      const confident = createPartialEvalConfidentResult({
        expression,
        metadata: context.metadata
      });
      const deopt = createPartialEvalDeoptResult({
        originalExpression: expression,
        fallbackExpression,
        reason: "unsupported-call-expression",
        owner,
        bindingName: "styles",
        memberPath: ["button"],
        deoptPath: [{ kind: "binding", name: "styles" }]
      });

      expect(context.policy).toEqual(JSX_CSS_PROP_PARTIAL_EVAL_POLICY);
      expect(context.policy.providerValueMode).toBe("value-to-fresh-ast");
      expect(context.limits).toEqual({
        ...PARTIAL_EVAL_DEFAULT_LIMITS,
        maxDepth: 3
      });
      expect(context.state.bindingStack[0]?.memberPath).toEqual(["button"]);
      expect(confident.kind).toBe("confident");
      expect(confident.confident).toBe(true);
      expect(getPartialEvalResultExpression(confident)).toBe(expression);
      expect(deopt.kind).toBe("deopt");
      expect(deopt.confident).toBe(false);
      expect(deopt.reason).toBe("unsupported-call-expression");
      expect(deopt.diagnostic.code).toBe("unsupported-syntax");
      expect(deopt.diagnostic.bindingName).toBe("styles");
      expect(deopt.diagnostic.memberPath).toEqual(["button"]);
      expect(deopt.diagnostic.deoptPath).toEqual([
        { kind: "binding", name: "styles" }
      ]);
      expect(getPartialEvalResultExpression(deopt)).toBe(fallbackExpression);
    });
  });

  describe("partial evaluator primitive reducer", () => {
    it("reduces transparent wrapper expressions to their primitive literal AST", () => {
      const literal = t.stringLiteral("wrapped");
      const wrappedExpression = t.tsAsExpression(
        t.tsNonNullExpression(t.parenthesizedExpression(literal)),
        t.tsStringKeyword()
      );

      const expression = expectConfidentExpression(
        reduceForTest(wrappedExpression)
      );

      expectStringLiteralExpression(expression, "wrapped");
      expect(expression).not.toBe(wrappedExpression);
      expect(expression).not.toBe(literal);
    });

    it("reduces string number boolean and null literal expressions as cloned AST", () => {
      const stringLiteral = t.stringLiteral("red");
      const numericLiteral = t.numericLiteral(4);
      const booleanLiteral = t.booleanLiteral(true);
      const nullLiteral = t.nullLiteral();

      const stringExpression = expectConfidentExpression(
        reduceForTest(stringLiteral)
      );
      const numericExpression = expectConfidentExpression(
        reduceForTest(numericLiteral)
      );
      const booleanExpression = expectConfidentExpression(
        reduceForTest(booleanLiteral)
      );
      const nullExpression = expectConfidentExpression(
        reduceForTest(nullLiteral)
      );

      expectStringLiteralExpression(stringExpression, "red");
      expectNumericLiteralExpression(numericExpression, 4);
      expectBooleanLiteralExpression(booleanExpression, true);
      expectNullLiteralExpression(nullExpression);
      expect(stringExpression).not.toBe(stringLiteral);
      expect(numericExpression).not.toBe(numericLiteral);
      expect(booleanExpression).not.toBe(booleanLiteral);
      expect(nullExpression).not.toBe(nullLiteral);
    });

    it("reduces no-expression template literals to string literal AST", () => {
      const templateLiteral = t.templateLiteral(
        [createTemplateElement("plain", true)],
        []
      );

      expectStringLiteralExpression(
        expectConfidentExpression(reduceForTest(templateLiteral)),
        "plain"
      );
    });

    it("reduces primitive template interpolations to string literal AST", () => {
      const templateLiteral = t.templateLiteral(
        [
          createTemplateElement("color-", false),
          createTemplateElement("-", false),
          createTemplateElement("", true)
        ],
        [
          t.stringLiteral("red"),
          t.binaryExpression("+", t.numericLiteral(1), t.numericLiteral(2))
        ]
      );

      expectStringLiteralExpression(
        expectConfidentExpression(reduceForTest(templateLiteral)),
        "color-red-3"
      );
    });

    it("reduces unary numeric and boolean primitive expressions", () => {
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(t.unaryExpression("-", t.numericLiteral(2)))
        ),
        -2
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(t.unaryExpression("+", t.numericLiteral(3)))
        ),
        3
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(t.unaryExpression("!", t.booleanLiteral(false)))
        ),
        true
      );
    });

    it("reduces binary primitive expressions", () => {
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("+", t.numericLiteral(1), t.numericLiteral(2))
          )
        ),
        3
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("-", t.numericLiteral(7), t.numericLiteral(2))
          )
        ),
        5
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("*", t.numericLiteral(3), t.numericLiteral(4))
          )
        ),
        12
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("/", t.numericLiteral(8), t.numericLiteral(2))
          )
        ),
        4
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("%", t.numericLiteral(5), t.numericLiteral(2))
          )
        ),
        1
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("**", t.numericLiteral(2), t.numericLiteral(3))
          )
        ),
        8
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(
              "+",
              t.stringLiteral("gap-"),
              t.numericLiteral(2)
            )
          )
        ),
        "gap-2"
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(
              "+",
              t.stringLiteral("enabled-"),
              t.booleanLiteral(true)
            )
          )
        ),
        "enabled-true"
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("+", t.nullLiteral(), t.stringLiteral("-value"))
          )
        ),
        "null-value"
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("<", t.numericLiteral(1), t.numericLiteral(2))
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("<=", t.numericLiteral(2), t.numericLiteral(2))
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(">", t.numericLiteral(3), t.numericLiteral(2))
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(">=", t.numericLiteral(3), t.numericLiteral(2))
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(
              "===",
              t.stringLiteral("same"),
              t.stringLiteral("same")
            )
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("===", t.nullLiteral(), t.nullLiteral())
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(
              "!==",
              t.stringLiteral("same"),
              t.stringLiteral("other")
            )
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(
              "!==",
              t.booleanLiteral(true),
              t.booleanLiteral(false)
            )
          )
        ),
        true
      );
    });

    it("reduces logical primitive expressions", () => {
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "&&",
              t.booleanLiteral(false),
              t.stringLiteral("right")
            )
          )
        ),
        false
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "&&",
              t.booleanLiteral(true),
              t.stringLiteral("right")
            )
          )
        ),
        "right"
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "&&",
              t.numericLiteral(1),
              t.stringLiteral("right")
            )
          )
        ),
        "right"
      );
      expectNullLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression("&&", t.nullLiteral(), t.stringLiteral("right"))
          )
        )
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "||",
              t.stringLiteral(""),
              t.stringLiteral("fallback")
            )
          )
        ),
        "fallback"
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression("||", t.numericLiteral(0), t.numericLiteral(2))
          )
        ),
        2
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "||",
              t.stringLiteral("left"),
              t.stringLiteral("fallback")
            )
          )
        ),
        "left"
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "??",
              t.nullLiteral(),
              t.stringLiteral("fallback")
            )
          )
        ),
        "fallback"
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression("??", t.numericLiteral(0), t.numericLiteral(1))
          )
        ),
        0
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "??",
              t.booleanLiteral(false),
              t.stringLiteral("fallback")
            )
          )
        ),
        false
      );
    });

    it("deopts unsupported call expressions with original fallback AST", () => {
      const callExpression = t.callExpression(t.identifier("makeRule"), []);
      const deopt = expectDeoptResult(reduceForTest(callExpression));

      expect(deopt.reason).toBe("unsupported-call-expression");
      expect(deopt.originalExpression).toBe(callExpression);
      expect(deopt.fallbackExpression).toBe(callExpression);
      expect(deopt.diagnostic.message).toBe(
        "Cannot partially evaluate css prop value: call expressions are not evaluated by Babel"
      );
    });

    it("deopts unsupported template interpolation with original fallback AST", () => {
      const templateLiteral = t.templateLiteral(
        [createTemplateElement("", false), createTemplateElement("", true)],
        [t.objectExpression([])]
      );
      const deopt = expectDeoptResult(reduceForTest(templateLiteral));

      expect(deopt.reason).toBe("unsupported-template-interpolation");
      expect(deopt.originalExpression).toBe(templateLiteral);
      expect(deopt.fallbackExpression).toBe(templateLiteral);
      expect(deopt.diagnostic.message).toBe(
        "Cannot partially evaluate css prop value: template interpolation is not a static primitive"
      );
    });
  });

  describe("partial evaluator same-file member object array spread reducer", () => {
    it("reduces same-file const object and direct member paths", () => {
      const results = reduceFixture(`
        const tokens = {
          button: { color: "red", gap: 4 },
          sizes: ["sm", "lg"]
        };

        capture(tokens.button);
        capture(tokens.button.color);
        capture(tokens.sizes[1]);
      `);

      const button = expectObjectExpression(
        expectFixtureConfidentExpression(results, 0)
      );

      expectStringLiteralExpression(
        expectObjectPropertyExpression(button, "color"),
        "red"
      );
      expectNumericLiteralExpression(
        expectObjectPropertyExpression(button, "gap"),
        4
      );
      expectStringLiteralExpression(
        expectFixtureConfidentExpression(results, 1),
        "red"
      );
      expectStringLiteralExpression(
        expectFixtureConfidentExpression(results, 2),
        "lg"
      );
    });

    it("reduces static computed key properties and computed member paths", () => {
      const results = reduceFixture(`
        const key = "color";
        const index = 1;
        const style = { [key]: "red", ["padding"]: 4 };
        const sizes = ["sm", "lg"];

        capture(style);
        capture(style[key]);
        capture(sizes[index]);
      `);

      const style = expectObjectExpression(
        expectFixtureConfidentExpression(results, 0)
      );

      expectStringLiteralExpression(
        expectObjectPropertyExpression(style, "color"),
        "red"
      );
      expectNumericLiteralExpression(
        expectObjectPropertyExpression(style, "padding"),
        4
      );
      expectStringLiteralExpression(
        expectFixtureConfidentExpression(results, 1),
        "red"
      );
      expectStringLiteralExpression(
        expectFixtureConfidentExpression(results, 2),
        "lg"
      );
    });

    it("reduces object spread and array spread operands", () => {
      const results = reduceFixture(`
        const base = { color: "red" };
        const extra = { padding: 4 };
        const prefix = ["base"];

        capture({ ...base, ...extra, display: "block" });
        capture([...prefix, "next", ...["last"]]);
      `);

      const style = expectObjectExpression(
        expectFixtureConfidentExpression(results, 0)
      );
      const list = expectArrayExpression(
        expectFixtureConfidentExpression(results, 1)
      );

      expectNoSpreadElement(style);
      expectNoSpreadElement(list);
      expectStringLiteralExpression(
        expectObjectPropertyExpression(style, "color"),
        "red"
      );
      expectNumericLiteralExpression(
        expectObjectPropertyExpression(style, "padding"),
        4
      );
      expectStringLiteralExpression(
        expectObjectPropertyExpression(style, "display"),
        "block"
      );
      expect(list.elements).toHaveLength(3);
      expectStringLiteralExpression(
        expectArrayElementExpression(list, 0),
        "base"
      );
      expectStringLiteralExpression(
        expectArrayElementExpression(list, 1),
        "next"
      );
      expectStringLiteralExpression(
        expectArrayElementExpression(list, 2),
        "last"
      );
    });

    it("deopts mutated same-file bindings and let var bindings", () => {
      const results = reduceFixture(`
        const mutated = { color: "red" };
        mutated.color = "blue";
        let mutable = { color: "red" };
        var hoisted = { color: "red" };

        capture(mutated);
        capture(mutable);
        capture(hoisted);
      `);

      for (let index = 0; index < 3; index += 1) {
        const deopt = expectFixtureDeoptResult(results, index);
        expect(deopt.reason).toBe("mutated-binding");
        expect(deopt.diagnostic.message).toContain("same-file binding");
      }
    });

    it("deopts alias cycle and binding depth limit", () => {
      const cycleResults = reduceFixture(`
        const a = b;
        const b = a;

        capture(a);
      `);
      const depthResults = reduceFixture(
        `
          const a = b;
          const b = { color: "red" };

          capture(a);
        `,
        { maxBindingStackDepth: 1 }
      );

      expect(expectFixtureDeoptResult(cycleResults, 0).reason).toBe(
        "cycle-detected"
      );
      expect(expectFixtureDeoptResult(depthResults, 0).reason).toBe(
        "depth-limit"
      );
    });

    it("deopts object methods getters computed runtime member key and runtime spread", () => {
      const results = reduceFixture(`
        const methodStyle = { color() { return "red"; } };
        const getterStyle = { get color() { return "red"; } };
        const style = { color: "red" };

        capture(methodStyle);
        capture(getterStyle);
        capture(style[props.key]);
        capture({ [props.key]: "red" });
        capture({ ...props });
        capture([...props]);
      `);

      expect(expectFixtureDeoptResult(results, 0).reason).toBe(
        "runtime-css-shape"
      );
      expect(expectFixtureDeoptResult(results, 1).reason).toBe(
        "runtime-css-shape"
      );
      expect(expectFixtureDeoptResult(results, 2).reason).toBe(
        "unsupported-computed-member"
      );
      expect(expectFixtureDeoptResult(results, 3).reason).toBe(
        "non-static-object-key"
      );
      expect(expectFixtureDeoptResult(results, 4).reason).toBe(
        "unsupported-spread"
      );
      expect(expectFixtureDeoptResult(results, 5).reason).toBe(
        "unsupported-spread"
      );
    });

    it("deopts imported unknown bindings at the resolver boundary", () => {
      const results = reduceFixture(`
        import { style } from "./style";

        capture(style);
      `);
      const deopt = expectFixtureDeoptResult(results, 0);

      expect(deopt.reason).toBe("unsupported-import");
      expect(deopt.diagnostic.bindingName).toBe("style");
    });
  });

  describe("partial evaluator deopt reasons", () => {
    it("constructs every required deopt reason", () => {
      const results = PARTIAL_EVAL_DEOPT_REASONS.map((reason) =>
        createPartialEvalDeoptResult({
          originalExpression: createReasonExpression(reason),
          reason,
          owner
        })
      );

      expect(PARTIAL_EVAL_DEOPT_REASONS).toEqual(requiredDeoptReasons);
      expect(results.map((result) => result.reason)).toEqual(
        requiredDeoptReasons
      );
      expect(
        results.map((result) => ({
          reason: result.reason,
          code: result.diagnostic.code,
          message: result.diagnostic.message
        }))
      ).toEqual([
        {
          reason: "mutated-binding",
          code: "mutation-detected",
          message:
            "Cannot partially evaluate css prop value: binding is mutated"
        },
        {
          reason: "unsupported-import",
          code: "unsupported-source",
          message:
            "Cannot partially evaluate css prop value: imported binding must be resolved by the static css provider"
        },
        {
          reason: "unsupported-call-expression",
          code: "unsupported-syntax",
          message:
            "Cannot partially evaluate css prop value: call expressions are not evaluated by Babel"
        },
        {
          reason: "non-static-object-key",
          code: "unsupported-syntax",
          message:
            "Cannot partially evaluate css prop value: object key is not statically known"
        },
        {
          reason: "unsupported-spread",
          code: "unsupported-syntax",
          message:
            "Cannot partially evaluate css prop value: spread operand is not statically reducible"
        },
        {
          reason: "unsupported-computed-member",
          code: "unsupported-syntax",
          message:
            "Cannot partially evaluate css prop value: computed member access is not statically known"
        },
        {
          reason: "runtime-css-shape",
          code: "unsupported-syntax",
          message:
            "Cannot partially evaluate css prop value: runtime css object shape is unsupported"
        },
        {
          reason: "unsupported-template-interpolation",
          code: "unsupported-syntax",
          message:
            "Cannot partially evaluate css prop value: template interpolation is not a static primitive"
        },
        {
          reason: "cycle-detected",
          code: "cycle-detected",
          message:
            "Cannot partially evaluate css prop value: binding cycle detected"
        },
        {
          reason: "depth-limit",
          code: "limit-exceeded",
          message:
            "Cannot partially evaluate css prop value: partial evaluator depth limit exceeded"
        },
        {
          reason: "node-count-limit",
          code: "limit-exceeded",
          message:
            "Cannot partially evaluate css prop value: partial evaluator node count limit exceeded"
        }
      ]);
    });

    it("exhaustively handles every deopt reason", () => {
      expect(PARTIAL_EVAL_DEOPT_REASONS.map(handleDeoptReasonForTest)).toEqual([
        "mutation",
        "import",
        "call",
        "object-key",
        "spread",
        "computed-member",
        "runtime-shape",
        "template",
        "cycle",
        "depth",
        "node-count"
      ]);
    });
  });
}
