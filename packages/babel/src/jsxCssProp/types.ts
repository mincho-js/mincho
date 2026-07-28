import type { NodePath, types as t } from "@babel/core";
import type {
  ResolutionDependency,
  StaticCssEvalCacheKey,
  StaticCssEvalDiagnostic,
  StaticCssEvalProvider
} from "../staticCssEval/types.js";

export type CssPropValueClassification =
  | "css-rule"
  | "branch-css-rule"
  | "class-value"
  | "unsupported-dynamic-css-rule"
  | "unsupported-array-spread"
  | "unsupported-function";

export type CssClassNameBaseLoweringRequest = {
  readonly path: NodePath<t.JSXOpeningElement>;
  readonly expression: t.Expression;
};

export type AggregatePropsBinding = {
  readonly declarations: t.VariableDeclaration[];
  readonly classNameIdentifier: t.Identifier;
  readonly restIdentifier: t.Identifier;
};

export type NormalizedJsxCssPropElement = {
  readonly cssAttribute: t.JSXAttribute;
  readonly cssExpression: t.Expression;
  readonly cssValueClassification: CssPropValueClassification;
  readonly classNameAttribute: t.JSXAttribute | null;
  readonly attributesBeforeCss: readonly (
    | t.JSXAttribute
    | t.JSXSpreadAttribute
  )[];
  readonly attributesAfterCss: readonly (
    | t.JSXAttribute
    | t.JSXSpreadAttribute
  )[];
  readonly hasSpreadBeforeCss: boolean;
  readonly hasSpreadAfterCss: boolean;
};

export type SpreadAggregatedCssPropLowering = {
  readonly declarations: t.VariableDeclaration[];
  readonly attributes: Array<t.JSXAttribute | t.JSXSpreadAttribute>;
};

export type CssClassNameRootResultLoweringRequest =
  CssClassNameBaseLoweringRequest & {
    readonly context: "root-result";
    readonly classification: CssPropValueClassification;
  };

export type CssClassNameBranchResultLoweringRequest =
  CssClassNameBaseLoweringRequest & {
    readonly context: "branch-result";
  };

export type CssClassNameArrayElementResultLoweringRequest =
  CssClassNameBaseLoweringRequest & {
    readonly context: "array-element-result";
  };

export type CssClassNameGuardLoweringRequest =
  CssClassNameBaseLoweringRequest & {
    readonly context: "guard";
  };

export type CssClassNameLoweringRequest =
  | CssClassNameRootResultLoweringRequest
  | CssClassNameBranchResultLoweringRequest
  | CssClassNameArrayElementResultLoweringRequest
  | CssClassNameGuardLoweringRequest;

export type StaticCssEvalMetadataSource = {
  dependencies?: readonly (ResolutionDependency | string)[];
  diagnostics?: readonly StaticCssEvalDiagnostic[];
  diagnostic?: StaticCssEvalDiagnostic;
  cacheKey?: StaticCssEvalCacheKey;
};

export type InlineStaticCssRuleLiteralResult =
  | { kind: "not-candidate" }
  | {
      kind: "resolved";
      expression: t.ObjectExpression | t.ArrayExpression;
      metadata: StaticCssEvalMetadataSource[];
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata: StaticCssEvalMetadataSource[];
    };

export type InlineStaticCssExpressionResult =
  | {
      kind: "resolved";
      expression: t.Expression;
      metadata: StaticCssEvalMetadataSource[];
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata: StaticCssEvalMetadataSource[];
    };

export type InlineStaticCssObjectExpressionResult =
  | {
      kind: "resolved";
      expression: t.ObjectExpression;
      metadata: StaticCssEvalMetadataSource[];
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata: StaticCssEvalMetadataSource[];
    };

export type InlineStaticCssArrayExpressionResult =
  | {
      kind: "resolved";
      expression: t.ArrayExpression;
      metadata: StaticCssEvalMetadataSource[];
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata: StaticCssEvalMetadataSource[];
    };

interface InlineStaticCssEvaluationState {
  count: number;
}

export interface InlineStaticCssEvaluationOptions {
  expression: t.Expression;
  ownerFile: string;
  programPath: NodePath<t.Program>;
  scope: NodePath<t.JSXOpeningElement>["scope"];
  provider?: StaticCssEvalProvider;
  metadata: StaticCssEvalMetadataSource[];
  localStack?: readonly InlineStaticCssLocalStackFrame[];
  state: InlineStaticCssEvaluationState;
  depth: number;
}

export interface InlineStaticCssLocalStackFrame {
  readonly bindingName: string;
  readonly memberPath: readonly string[];
}
