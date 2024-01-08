import type { ComplexStyleRule, StyleRule } from "@vanilla-extract/css";
import type { Properties } from "csstype";
import type { NonNullableString } from "./string";
import type { SimplePseudos, CamelPseudos } from "./simple-pseudo";

// == Vanilla Extract Inteface ================================================
// https://github.com/vanilla-extract-css/vanilla-extract/blob/master/packages/css/src/types.ts
export type VanillaStyleRuleKey = keyof StyleRule;
export type VanillaStyleRuleValue = StyleRule[VanillaStyleRuleKey];

export type VanillaStyleArray = Exclude<ComplexStyleRule, StyleRule>;
export type VanillaClassNames = Exclude<VanillaStyleArray[number], StyleRule>;

// == Interface ===============================================================
export type ComplexCSSRule = CSSRule | Array<ComplexCSSItem>;
export type ComplexCSSItem = CSSRule | ClassNames;

export type CSSRule = StyleWithSelectors & WithQueries<StyleWithSelectors>;
export type GlobalCSSRule = CSSPropertiesWithVars &
  WithQueries<CSSPropertiesWithVars>;

export type CSSRuleKey = keyof CSSRule;
export type CSSRuleValue = CSSRule[CSSRuleKey];

export type ClassNames = string | Array<ClassNames>;

// == Style with Selectors ====================================================
// -- Main --------------------------------------------------------------------
export type StyleWithSelectors = CSSPropertiesAndPseudos & SelectorProperty; // TODO: SelectorProperties

// -- Psesudo -----------------------------------------------------------------
type CSSPropertiesAndPseudos = CSSPropertiesWithVars & PseudoProperties;

type PseudoProperties = {
  [key in SimplePseudos | CamelPseudos]?: CSSPropertiesWithVars;
};

// -- Selector ----------------------------------------------------------------
export type SelectorProperties = ToplevelSelector & SelectorProperty;

type SelectorProperty = {
  selectors?: SelectorMap;
};
type ToplevelSelector = Partial<{
  [selector: NonNullableString]: SelectorValues;
}>;

type SelectorValues = CSSPropertiesWithVars &
  WithQueries<CSSPropertiesWithVars>;
interface SelectorMap {
  [selector: NonNullableString]: SelectorValues;
}

// == CSS Properties ==========================================================
// -- Main --------------------------------------------------------------------
export type CSSPropertiesWithVars = CSSComplexProperties &
  VarProperty &
  TopLevelVar;
export type VarProperty = {
  vars?: CSSVarMap;
};
export type TopLevelVar = Partial<CSSVarMap>;
type CSSVarMap = {
  [key: CSSVarKey]: CSSVarValue;
};

export type CSSComplexProperties = CSSProperties & CSSMergeProperties;

// -- Properties --------------------------------------------------------------
export type CSSProperties = {
  [Property in keyof CSSTypeProperties]:
    | CSSTypeProperties[Property]
    | CSSVarFunction
    | Array<CSSVarFunction | CSSTypeProperties[Property]>;
};

export type CSSVarKey = `--${string}` | `$${string}`;
export type CSSVarValue = `${string | number}`;

// https://github.com/vanilla-extract-css/vanilla-extract/blob/master/packages/private/src/types.ts
export type CSSVarFunction =
  | `var(--${string})`
  | `var(--${string}, ${CSSVarValue})`
  | `$${string}`
  | `$${string}(${CSSVarValue})`;

// TODO: Instead of enabling all properties, we recommend enabling only some properties.
// https://github.com/mincho-js/working-group/blob/main/text/000-css-literals.md#7-merge-values
// https://developer.mozilla.org/en-US/docs/Web/CSS/Shorthand_properties
// https://github.com/mdn/data/blob/main/css/README.md
export type CSSMergeProperties = {
  [Property in keyof CSSProperties as `${Property}$` | `${Property}_`]: Array<
    CSSProperties[Property]
  >;
};

type CSSTypeProperties = Properties<number | NonNullableString> &
  ContainerProperties;

// csstype is yet to ship container property types as they are not in
// the output MDN spec files yet. Remove this once that's done.
// https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Container_Queries
interface ContainerProperties {
  container?: string;
  containerType?: "size" | "inline-size" | NonNullableString;
  containerName?: string;
}

// == CSS Queries =============================================================
// -- Main --------------------------------------------------------------------
export type WithQueries<StyleType> = StyleType & AllQueries<StyleType>;

// -- Utils -------------------------------------------------------------------
type AtRulesKeywords = "media" | "supports" | "container" | "layer";
type AtRules<StyleType> = NestedAtRules<StyleType> & TopLevelAtRules<StyleType>;
interface AllQueries<StyleType>
  extends AtRules<StyleType & AllQueries<StyleType>> {}

type NestedAtRules<StyleType> = {
  [key in AtRulesKeywords as `@${key}`]?: {
    [query: string]: StyleType;
  };
};

type TopLevelAtRules<StyleType> = {
  [key in AtRulesKeywords as `@${key} ${string}`]?: StyleType;
};

// == Others ==================================================================
export interface CSSKeyframes {
  [time: string]: CSSComplexProperties;
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expectTypeOf } = import.meta.vitest;

  describe.concurrent("CSS Rules", () => {
    it("Unitless", () => {
      const unitless: CSSRule = {
        // cast to pixels
        padding: 10,
        marginTop: 25,

        // unitless properties
        flexGrow: 1,
        opacity: 0.5
      };
      expectTypeOf<CSSRule>().toMatchTypeOf(unitless);
    });

    it("Vendor Prefix", () => {
      const vender: CSSRule = {
        WebkitTapHighlightColor: "rgba(0, 0, 0, 0)"
      };
      expectTypeOf<CSSRule>().toMatchTypeOf(vender);
    });

    it("Fallback styles", () => {
      const fallback: CSSRule = {
        overflow: ["auto", "overlay"]
      };
      expectTypeOf<CSSRule>().toMatchTypeOf(fallback);
    });

    it("Merge Values", () => {
      const merged: CSSRule = {
        boxShadow$: ["inset 0 0 10px #555", "0 0 20px black"],
        transform_: ["scale(2)", "rotate(15deg)"]
      };
      expectTypeOf<CSSRule>().toMatchTypeOf(merged);
    });

    it("CSS var", () => {
      // Toplevel Var
      const cssVar: CSSRule = {
        $customVar: "none",
        "--custom-var": "none",

        // Var Properties
        vars: {
          $customVar: "none",
          "--custom-var": "none"
        },

        // Usage
        border: "$customVar",
        background: "$fallbackVar(red)",
        outline: "var(--custom-var)",
        display: "var(--fallback-var, flex)"
      };
      expectTypeOf<CSSRule>().toMatchTypeOf(cssVar);
    });

    it("Simple Pseudo selectors", () => {
      const simplePseudos: CSSRule = {
        // Literal pseudo
        _hover: {
          color: "pink"
        },
        _firstOfType: {
          color: "blue"
        },
        __before: {
          content: ""
        },

        // Backward compatibility
        ":hover": {
          color: "pink"
        },
        ":first-of-type": {
          color: "blue"
        },
        "::before": {
          content: ""
        }
      };
      expectTypeOf<CSSRule>().toMatchTypeOf(simplePseudos);
    });

    it("AtRules", () => {
      const atRules: CSSRule = {
        // Toplevel rules
        "@media screen and (min-width: 768px)": {
          color: "red",

          // Nested
          "@supports selector(h2 > p)": {
            color: "green"
          },
          "@supports": {
            "(transform-origin: 5% 5%)": {
              color: "blue"
            }
          }
        },

        // Nested at rules
        "@media": {
          "screen and (min-width: 768px)": {
            color: "red",

            // Nested
            "@supports selector(h2 > p)": {
              color: "green"
            },
            "@supports": {
              "(transform-origin: 5% 5%)": {
                color: "blue"
              }
            }
          }
        }
      };
      expectTypeOf<CSSRule>().toMatchTypeOf(atRules);
    });
  });
}
