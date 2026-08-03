import type { StaticCssApiKind } from "./policy.js";
import type { PartialEvalDeoptReason } from "./partialEvaluator/index.js";

export const STATIC_CSS_DEOPT_GROUPS = [
  "policy",
  "syntax-reducer",
  "binding-provenance",
  "dependency-source",
  "sidecar-hoistability",
  "project-cache"
] as const;

export type StaticCssDeoptGroup = (typeof STATIC_CSS_DEOPT_GROUPS)[number];

export type PartialEvalDeoptTaxonomyEntry = {
  readonly reason: PartialEvalDeoptReason;
  readonly group: StaticCssDeoptGroup;
  readonly policy: StaticCssApiKind;
};

export const PARTIAL_EVAL_DEOPT_REASONS_BY_POLICY_ORDER = [
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

export const PARTIAL_EVAL_DEOPT_TAXONOMY = {
  "mutated-binding": {
    reason: "mutated-binding",
    group: "binding-provenance",
    policy: "jsx-css-prop"
  },
  "unsupported-import": {
    reason: "unsupported-import",
    group: "dependency-source",
    policy: "jsx-css-prop"
  },
  "unsupported-call-expression": {
    reason: "unsupported-call-expression",
    group: "sidecar-hoistability",
    policy: "jsx-css-prop"
  },
  "non-static-object-key": {
    reason: "non-static-object-key",
    group: "syntax-reducer",
    policy: "jsx-css-prop"
  },
  "unsupported-spread": {
    reason: "unsupported-spread",
    group: "syntax-reducer",
    policy: "jsx-css-prop"
  },
  "unsupported-computed-member": {
    reason: "unsupported-computed-member",
    group: "syntax-reducer",
    policy: "jsx-css-prop"
  },
  "runtime-css-shape": {
    reason: "runtime-css-shape",
    group: "policy",
    policy: "jsx-css-prop"
  },
  "unsupported-template-interpolation": {
    reason: "unsupported-template-interpolation",
    group: "syntax-reducer",
    policy: "jsx-css-prop"
  },
  "cycle-detected": {
    reason: "cycle-detected",
    group: "project-cache",
    policy: "jsx-css-prop"
  },
  "depth-limit": {
    reason: "depth-limit",
    group: "project-cache",
    policy: "jsx-css-prop"
  },
  "node-count-limit": {
    reason: "node-count-limit",
    group: "project-cache",
    policy: "jsx-css-prop"
  }
} as const satisfies Record<
  PartialEvalDeoptReason,
  PartialEvalDeoptTaxonomyEntry
>;
