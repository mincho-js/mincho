import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { Binding, Scope } from "@babel/traverse";
import type {
  BindingProvenance,
  ResolutionChainEntry,
  ResolutionDependency,
  StaticCssEvalDiagnostic,
  StaticCssEvalSourceLocation
} from "../types.js";

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

export interface SameFileStaticCssEvalContext {
  bindingName: string;
  memberPath: string[];
  owner: StaticCssEvalSourceLocation;
}

export interface SameFileStaticCssEvalMetadata {
  provenance: BindingProvenance;
  dependencies: ResolutionDependency[];
  resolutionChain: ResolutionChainEntry[];
}

export type SameFileBindingResolutionResult =
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

export interface SameFileBindingResolutionOptions {
  binding: Binding;
  bindingName: string;
  memberPath: string[];
  ownerFile: string;
  owner: StaticCssEvalSourceLocation;
  programPath: NodePath<t.Program>;
  stack: SameFileBindingStackFrame[];
}

export interface SameFileBindingStackFrame {
  binding: Binding;
  bindingName: string;
  memberPath: string[];
}

export type SameFileDeclarationKind =
  | "const"
  | "let"
  | "var"
  | "function"
  | "class";

export interface LiteralValidationState {
  count: number;
}

export type SameFileStaticLiteralEvaluationResult =
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

export interface SameFileStaticLiteralEvaluationOptions {
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
