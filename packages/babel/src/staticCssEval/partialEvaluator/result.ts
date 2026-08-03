import type { types as t } from "@babel/core";
import type {
  BindingProvenance,
  ResolutionChainEntry,
  ResolutionDependency,
  StaticCssEvalCacheKey,
  StaticCssEvalDiagnostic,
  StaticCssEvalDiagnosticCode,
  StaticCssEvalSourceLocation
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

export interface PartialEvalDiagnostic {
  readonly code: StaticCssEvalDiagnosticCode;
  readonly reason: PartialEvalDeoptReason;
  readonly message: string;
  readonly detail?: string;
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

export function createPartialEvalDiagnostic(
  options: CreatePartialEvalDiagnosticOptions
): PartialEvalDiagnostic {
  const detail = options.detail ?? formatPartialEvalDeoptReason(options.reason);

  return {
    code: getPartialEvalDeoptReasonDiagnosticCode(options.reason),
    reason: options.reason,
    message: `${PARTIAL_EVAL_DIAGNOSTIC_MESSAGE_PREFIX}: ${detail}`,
    detail,
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
      return "computed member access is unsupported";
    case "runtime-css-shape":
      return "runtime CSS object shape is unsupported";
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

export function clonePartialEvalSourceLocation(
  owner: StaticCssEvalSourceLocation
): StaticCssEvalSourceLocation {
  return { ...owner };
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
