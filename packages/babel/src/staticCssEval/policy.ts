export const STATIC_CSS_API_KINDS = [
  "jsx-css-prop",
  "css-authoring",
  "rules-authoring",
  "theme-token",
  "styled-variant"
] as const;

export type StaticCssApiKind = (typeof STATIC_CSS_API_KINDS)[number];

export const STATIC_CSS_API_POLICY_STATES = ["enabled", "inert"] as const;

export type StaticCssApiPolicyState =
  (typeof STATIC_CSS_API_POLICY_STATES)[number];

export const STATIC_CSS_IMPORT_MODES = [
  "provider-result-only",
  "inert"
] as const;

export type StaticCssImportMode = (typeof STATIC_CSS_IMPORT_MODES)[number];

export const STATIC_CSS_CALL_MODES = ["deopt", "inert"] as const;

export type StaticCssCallMode = (typeof STATIC_CSS_CALL_MODES)[number];

export const STATIC_CSS_MEMBER_PATH_MODES = ["static-only", "inert"] as const;

export type StaticCssMemberPathMode =
  (typeof STATIC_CSS_MEMBER_PATH_MODES)[number];

export const STATIC_CSS_COMPUTED_KEY_MODES = ["static-only", "inert"] as const;

export type StaticCssComputedKeyMode =
  (typeof STATIC_CSS_COMPUTED_KEY_MODES)[number];

export const STATIC_CSS_SPREAD_MODES = ["static-only", "inert"] as const;

export type StaticCssSpreadMode = (typeof STATIC_CSS_SPREAD_MODES)[number];

export const STATIC_CSS_TEMPLATE_INTERPOLATION_MODES = [
  "static-primitive-only",
  "inert"
] as const;

export type StaticCssTemplateInterpolationMode =
  (typeof STATIC_CSS_TEMPLATE_INTERPOLATION_MODES)[number];

export const STATIC_CSS_DYNAMIC_LEAF_MODES = ["css-variable", "inert"] as const;

export type StaticCssDynamicLeafMode =
  (typeof STATIC_CSS_DYNAMIC_LEAF_MODES)[number];

export const STATIC_CSS_SIDECAR_DELEGATION_MODES = [
  "whole-rule",
  "inert"
] as const;

export type StaticCssSidecarDelegationMode =
  (typeof STATIC_CSS_SIDECAR_DELEGATION_MODES)[number];

export type StaticCssApiPolicy = {
  readonly kind: StaticCssApiKind;
  readonly state: StaticCssApiPolicyState;
  readonly imports: {
    readonly mode: StaticCssImportMode;
    readonly staticBindings: boolean;
    readonly providerResultOnly: boolean;
  };
  readonly calls: {
    readonly mode: StaticCssCallMode;
    readonly evaluate: boolean;
    readonly deoptInReducer: boolean;
  };
  readonly memberPaths: {
    readonly mode: StaticCssMemberPathMode;
    readonly staticMembers: boolean;
    readonly optionalStaticMembers: boolean;
  };
  readonly computedKeys: {
    readonly mode: StaticCssComputedKeyMode;
    readonly staticObjectKeys: boolean;
    readonly dynamicObjectKeys: boolean;
  };
  readonly spreads: {
    readonly mode: StaticCssSpreadMode;
    readonly staticObjectArray: boolean;
    readonly dynamicObjectArray: boolean;
  };
  readonly templateInterpolation: {
    readonly mode: StaticCssTemplateInterpolationMode;
    readonly staticPrimitives: boolean;
    readonly runtimeValues: boolean;
  };
  readonly dynamicLeaves: {
    readonly mode: StaticCssDynamicLeafMode;
    readonly cssVariables: boolean;
    readonly runtimeCssObjects: boolean;
  };
  readonly sidecarDelegation: {
    readonly mode: StaticCssSidecarDelegationMode;
    readonly enabled: boolean;
    readonly wholeRuleOnly: boolean;
  };
};

const INERT_STATIC_CSS_API_CAPABILITIES = {
  imports: {
    mode: "inert",
    staticBindings: false,
    providerResultOnly: false
  },
  calls: {
    mode: "inert",
    evaluate: false,
    deoptInReducer: false
  },
  memberPaths: {
    mode: "inert",
    staticMembers: false,
    optionalStaticMembers: false
  },
  computedKeys: {
    mode: "inert",
    staticObjectKeys: false,
    dynamicObjectKeys: false
  },
  spreads: {
    mode: "inert",
    staticObjectArray: false,
    dynamicObjectArray: false
  },
  templateInterpolation: {
    mode: "inert",
    staticPrimitives: false,
    runtimeValues: false
  },
  dynamicLeaves: {
    mode: "inert",
    cssVariables: false,
    runtimeCssObjects: false
  },
  sidecarDelegation: {
    mode: "inert",
    enabled: false,
    wholeRuleOnly: false
  }
} as const satisfies Omit<StaticCssApiPolicy, "kind" | "state">;

export const STATIC_CSS_API_POLICIES = {
  "jsx-css-prop": {
    kind: "jsx-css-prop",
    state: "enabled",
    imports: {
      mode: "provider-result-only",
      staticBindings: true,
      providerResultOnly: true
    },
    calls: {
      mode: "deopt",
      evaluate: false,
      deoptInReducer: true
    },
    memberPaths: {
      mode: "static-only",
      staticMembers: true,
      optionalStaticMembers: true
    },
    computedKeys: {
      mode: "static-only",
      staticObjectKeys: true,
      dynamicObjectKeys: false
    },
    spreads: {
      mode: "static-only",
      staticObjectArray: true,
      dynamicObjectArray: false
    },
    templateInterpolation: {
      mode: "static-primitive-only",
      staticPrimitives: true,
      runtimeValues: false
    },
    dynamicLeaves: {
      mode: "css-variable",
      cssVariables: true,
      runtimeCssObjects: false
    },
    sidecarDelegation: {
      mode: "whole-rule",
      enabled: true,
      wholeRuleOnly: true
    }
  },
  "css-authoring": {
    kind: "css-authoring",
    state: "inert",
    ...INERT_STATIC_CSS_API_CAPABILITIES
  },
  "rules-authoring": {
    kind: "rules-authoring",
    state: "inert",
    ...INERT_STATIC_CSS_API_CAPABILITIES
  },
  "theme-token": {
    kind: "theme-token",
    state: "inert",
    ...INERT_STATIC_CSS_API_CAPABILITIES
  },
  "styled-variant": {
    kind: "styled-variant",
    state: "inert",
    ...INERT_STATIC_CSS_API_CAPABILITIES
  }
} as const satisfies Record<StaticCssApiKind, StaticCssApiPolicy>;

export const INERT_STATIC_CSS_API_KINDS: readonly StaticCssApiKind[] =
  STATIC_CSS_API_KINDS.filter(
    (kind) => STATIC_CSS_API_POLICIES[kind].state === "inert"
  );
