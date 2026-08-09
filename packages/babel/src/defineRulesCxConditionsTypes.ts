import type { Binding } from "@babel/traverse";

export const DEFINE_RULES_IMPORT_PATH = "@mincho-js/css";
export const DEFINE_RULES_IMPORT_NAME = "defineRules";
export const DEFINE_RULES_CX_RUNTIME_IMPORT_PATH =
  "@mincho-js/css/defineRules/createDefineRulesCxRuntime";
export const DEFINE_RULES_CX_RUNTIME_IMPORT_NAME = "createDefineRulesCxRuntime";
export const DEFINE_RULES_SEGMENT_MARKER_PREFIX = "__mincho_seg_";
export const DEFINE_RULES_CX_CONDITIONS_METADATA_KEY =
  "minchoDefineRulesCxConditions";

export type DefineRulesCxCalleeKind =
  | "local-defineRules"
  | "local-createDefineRulesCxRuntime"
  | "provider-createDefineRulesCxRuntime";

export type DefineRulesCxClassOperandSource =
  | "local-css-call"
  | "provider-marker";

export type DefineRulesCxOperandMetadata =
  | {
      readonly kind: "class";
      readonly source: DefineRulesCxClassOperandSource;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "condition";
      readonly operator: "&&";
      readonly condition: DefineRulesCxExpressionRange;
      readonly classOperand: DefineRulesCxClassOperandMetadata;
    }
  | {
      readonly kind: "ternary";
      readonly condition: DefineRulesCxExpressionRange;
      readonly consequent: DefineRulesCxClassOperandMetadata;
      readonly alternate: DefineRulesCxClassOperandMetadata;
    }
  | {
      readonly kind: "array";
      readonly operands: readonly DefineRulesCxOperandMetadata[];
      readonly start: number;
      readonly end: number;
    };

export type DefineRulesCxClassOperandMetadata = Extract<
  DefineRulesCxOperandMetadata,
  { readonly kind: "class" }
>;

export interface DefineRulesCxExpressionRange {
  readonly start: number;
  readonly end: number;
}

export interface DefineRulesCxConditionsCallMetadata {
  readonly callee: DefineRulesCxCalleeKind;
  readonly start: number;
  readonly end: number;
  readonly operandCount: number;
  readonly conditionCount: number;
  readonly classOperandCount: number;
  readonly operands: readonly DefineRulesCxOperandMetadata[];
}

export interface DefineRulesCxConditionsMetadata {
  calls: DefineRulesCxConditionsCallMetadata[];
}

export type DefineRulesRuntimeRef =
  | {
      readonly callee: "local-defineRules";
      readonly namespaceBinding?: Binding;
      readonly cssBinding?: Binding;
    }
  | {
      readonly callee: "local-createDefineRulesCxRuntime";
    }
  | {
      readonly callee: "provider-createDefineRulesCxRuntime";
    };

export interface StaticReference {
  readonly bindingName: string;
  readonly memberPath: readonly string[];
}
