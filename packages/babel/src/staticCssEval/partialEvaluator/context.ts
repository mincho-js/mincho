import type { NodePath, types as t } from "@babel/core";
import type { Scope } from "@babel/traverse";
import {
  STATIC_CSS_EVAL_LIMITS,
  type StaticCssEvalSourceLocation
} from "../types.js";
import {
  clonePartialEvalSourceLocation,
  createPartialEvalMetadata,
  type PartialEvalMetadata
} from "./result.js";

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

function clonePartialEvalBindingFrame(
  frame: PartialEvalBindingFrame
): PartialEvalBindingFrame {
  return {
    bindingName: frame.bindingName,
    memberPath: [...frame.memberPath],
    owner: clonePartialEvalSourceLocation(frame.owner)
  };
}
