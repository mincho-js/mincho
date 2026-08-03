import type { NodePath, types as t } from "@babel/core";
import type { Scope } from "@babel/traverse";
import type { PartialEvalBindingFrame, PartialEvalContext } from "./context.js";
import {
  createPartialEvalConfidentResult,
  createPartialEvalDeoptResult,
  type CreatePartialEvalDiagnosticOptions,
  type PartialEvalConfidentResult,
  type PartialEvalDeoptReason,
  type PartialEvalDeoptResult,
  type PartialEvalResult
} from "./result.js";

export type PartialEvalDeoptDetails = Pick<
  CreatePartialEvalDiagnosticOptions,
  "bindingName" | "deoptPath" | "detail" | "memberPath"
> & {
  readonly fallbackExpression?: t.Expression;
};

export type PendingPartialEvalDeopt = {
  readonly reason: PartialEvalDeoptReason;
  readonly details: PartialEvalDeoptDetails;
};

export interface PartialEvalReductionContext {
  readonly bindingStack: readonly PartialEvalBindingFrame[];
  readonly programPath?: NodePath<t.Program>;
  readonly scope?: Scope;
}

export interface ReducePartialEvalExpressionOptions {
  readonly expression: t.Expression;
  readonly depth: number;
  readonly reductionContext: PartialEvalReductionContext;
}

export interface PartialEvalReducerNodeOptions<TNode extends t.Node> {
  readonly expression: t.Expression;
  readonly node: TNode;
  readonly depth: number;
  readonly reductionContext: PartialEvalReductionContext;
  readonly runtime: PartialEvalReducerRuntime;
}

export interface CreateReducerDeoptResultOptions {
  readonly expression: t.Expression;
  readonly reason: PartialEvalDeoptReason;
  readonly details?: PartialEvalDeoptDetails;
}

export interface CreateReducerDeoptFromChildOptions {
  readonly expression: t.Expression;
  readonly result: PartialEvalDeoptResult;
  readonly reason?: PartialEvalDeoptReason;
  readonly fallbackExpression?: t.Expression;
  readonly memberPath?: readonly string[];
}

export interface CreateReducerPendingDeoptOptions {
  readonly result: PartialEvalDeoptResult;
  readonly reason?: PartialEvalDeoptReason;
}

export interface PartialEvalReducerRuntime {
  readonly context: PartialEvalContext;
  readonly reduceExpression: (
    options: ReducePartialEvalExpressionOptions
  ) => PartialEvalResult;
  readonly createConfidentResult: (
    expression: t.Expression
  ) => PartialEvalConfidentResult;
  readonly createDeoptResult: (
    options: CreateReducerDeoptResultOptions
  ) => PartialEvalDeoptResult;
  readonly createDeoptFromChild: (
    options: CreateReducerDeoptFromChildOptions
  ) => PartialEvalDeoptResult;
  readonly createPendingDeoptFromChild: (
    options: CreateReducerPendingDeoptOptions
  ) => PendingPartialEvalDeopt;
  readonly getContextualDeoptReason: (
    result: PartialEvalDeoptResult,
    fallbackReason: PartialEvalDeoptReason
  ) => PartialEvalDeoptReason;
}

export function createPartialEvalReducerRuntime(
  context: PartialEvalContext,
  reduceExpression: (
    options: ReducePartialEvalExpressionOptions
  ) => PartialEvalResult
): PartialEvalReducerRuntime {
  function createConfidentResult(
    expression: t.Expression
  ): PartialEvalConfidentResult {
    return createPartialEvalConfidentResult({
      expression,
      metadata: context.metadata
    });
  }

  function createDeoptResult(
    options: CreateReducerDeoptResultOptions
  ): PartialEvalDeoptResult {
    return createPartialEvalDeoptResult({
      originalExpression: options.expression,
      fallbackExpression: options.expression,
      reason: options.reason,
      owner: context.owner,
      metadata: context.metadata,
      ...(options.details ?? {})
    });
  }

  function createDeoptFromChild(
    options: CreateReducerDeoptFromChildOptions
  ): PartialEvalDeoptResult {
    return createDeoptResult({
      expression: options.expression,
      reason: options.reason ?? options.result.reason,
      details: {
        ...copyChildDeoptDetails(options.result),
        ...(options.memberPath !== undefined
          ? { memberPath: options.memberPath }
          : {}),
        ...(options.fallbackExpression !== undefined
          ? { fallbackExpression: options.fallbackExpression }
          : {})
      }
    });
  }

  function createPendingDeoptFromChild(
    options: CreateReducerPendingDeoptOptions
  ): PendingPartialEvalDeopt {
    return {
      reason: options.reason ?? options.result.reason,
      details: copyChildDeoptDetails(options.result)
    };
  }

  return {
    context,
    reduceExpression,
    createConfidentResult,
    createDeoptResult,
    createDeoptFromChild,
    createPendingDeoptFromChild,
    getContextualDeoptReason
  };
}

export function getContextualDeoptReason(
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

function copyChildDeoptDetails(
  result: PartialEvalDeoptResult
): PartialEvalDeoptDetails {
  return {
    ...(result.diagnostic.detail !== undefined
      ? { detail: result.diagnostic.detail }
      : {}),
    ...(result.diagnostic.bindingName !== undefined
      ? { bindingName: result.diagnostic.bindingName }
      : {}),
    ...(result.diagnostic.deoptPath !== undefined
      ? { deoptPath: result.diagnostic.deoptPath }
      : {}),
    ...(result.diagnostic.memberPath !== undefined
      ? { memberPath: result.diagnostic.memberPath }
      : {})
  };
}
