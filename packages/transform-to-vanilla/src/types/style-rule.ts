/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { StyleRule } from "@vanilla-extract/css";
import type {
  Properties,
  Property,
  NonNullableString
} from "@mincho-js/csstype";
import type {
  CamelPseudos,
  SpacePropertiesKey,
  CommaPropertiesKey,
  NestedPropertiesMap
} from "@mincho-js/css-additional-types";
import type { GlobalFontFaceRule } from "./fontface-rule";
import type { IntRange, Spread } from "./utils";

// == Vanilla Extract Interface ===============================================
// https://github.com/vanilla-extract-css/vanilla-extract/blob/master/packages/css/src/types.ts
export type VanillaStyleRuleKey = keyof StyleRule;
export type VanillaStyleRuleValue = StyleRule[VanillaStyleRuleKey];

export type VanillaStyleArray = Array<StyleRule | ClassNames>;
export type VanillaClassNames = ClassNames;

// == Interface ===============================================================
export type ComplexCSSRule = CSSRule | Array<ComplexCSSItem>;
export type ComplexCSSItem =
  | CSSRule
  | ClassNames
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | ((...args: any[]) => ClassNames);

export interface CSSRule
  extends CSSPropertiesWithConditions,
    SelectorProperty {}
export interface GlobalCSSRule extends CSSPropertiesWithConditions {}

export type CSSRuleKey = keyof CSSRule;
export type CSSRuleValue = CSSRule[CSSRuleKey];

export type ClassNames = string | Array<ClassNames>;

// == CSS Properties ==========================================================
// -- Main --------------------------------------------------------------------
export interface CSSPropertiesWithConditions
  extends CSSPropertiesWithVars,
    WithConditions<CSSPropertiesWithVars> {}

export interface CSSPropertiesWithVars
  extends CSSComplexProperties,
    VarProperty,
    TopLevelVar {}

export interface CSSComplexProperties
  extends CSSProperties,
    CSSMergeProperties {}

// -- Properties --------------------------------------------------------------
export type CSSProperties = {
  [Property in keyof WithAnonymousCSSProperties]:
    | AnonymousCSSPropertyValue<Property>
    | (Property extends KeyofNestedPropertiesMap
        ? Spread<
            [
              NestedProperty<Property>,
              PropertyBasedCondition<
                AnonymousCSSPropertyValue<Property> | NestedProperty<Property>
              >
            ]
          >
        : PropertyBasedCondition<AnonymousCSSPropertyValue<Property>>);
};

type KeyofAnonymousCSSProperties = keyof WithAnonymousCSSProperties;
type KeyofNestedPropertiesMap = keyof NestedPropertiesMap;

type AnonymousCSSPropertyValue<Property extends KeyofAnonymousCSSProperties> =
  CSSPropertyValue<WithAnonymousCSSProperties[Property]>;

type CSSPropertyValue<PropertyValue> =
  | PropertyValue
  | CSSVarFunction
  | Array<PropertyValue | CSSVarFunction>;
type NestedPropertyValue<PropertyValue> =
  | PropertyValue
  | PropertyBasedCondition<PropertyValue>;

type NestedProperty<Property extends KeyofNestedPropertiesMap> = {
  [NestedProperty in keyof NestedPropertiesMap[Property]]?: NestedPropertyValue<
    AnonymousCSSPropertyValue<
      Extract<
        NestedPropertiesMap[Property][NestedProperty],
        keyof WithAnonymousCSSProperties
      >
    >
  >;
};

export interface PropertyBasedCondition<PropertyValue>
  extends CSSPropertyConditions<NestedPropertyValue<PropertyValue>> {}
interface CSSPropertyConditions<PropertyValue>
  extends CSSConditions<PropertyValue> {
  base?: PropertyValue;
}

// -- Selector ----------------------------------------------------------------
interface SelectorProperty {
  /**
   * More complex rules can be written using the `selectors` key.
   *
   * @see https://vanilla-extract.style/documentation/styling/#complex-selectors
   */
  selectors?: ComplexSelectors<CSSPropertiesWithConditions>;
}

// -- Var Properties ----------------------------------------------------------
export interface VarProperty {
  /**
   * Custom properties are scoped to the element(s) they are declared on, and participate in the cascade: the value of such a custom property is that from the declaration decided by the cascading algorithm.
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/--*
   */
  vars?: TopLevelVar;
}
interface TopLevelVar {
  [key: CSSVarKey]: CSSVarValue;
}

export type CSSVarKey = `--${string}` | `$${string}`;
export type CSSVarValue = `${string | number}`;

// https://github.com/vanilla-extract-css/vanilla-extract/blob/master/packages/private/src/types.ts
export type CSSVarFunction =
  | `var(--${string})`
  | `var(--${string}, ${CSSVarValue})`
  | `$${string}`
  | `$${string}(${CSSVarValue})`;

// -- Merge Properties --------------------------------------------------------
// Instead of enabling all properties, we recommend enabling only some properties.
// https://github.com/mincho-js/working-group/blob/main/text/000-css-literals.md#7-merge-values
// https://developer.mozilla.org/en-US/docs/Web/CSS/Shorthand_properties
// https://github.com/mdn/data/blob/main/css/README.md
interface SpaceProperties extends Pick<CSSProperties, SpacePropertiesKey> {}
interface CommaProperties extends Pick<CSSProperties, CommaPropertiesKey> {}
type SpaceMergeProperties = {
  [SpaceProperty in keyof SpaceProperties as `${SpaceProperty}_`]: Array<
    SpaceProperties[SpaceProperty]
  >;
};
type CommaMergeProperties = {
  [CommaProperty in keyof CommaProperties as `${CommaProperty}$`]: Array<
    CommaProperties[CommaProperty]
  >;
};
export interface CSSMergeProperties
  extends SpaceMergeProperties,
    CommaMergeProperties {}

// == CSS Conditions ==========================================================
// -- Main --------------------------------------------------------------------
export type WithConditions<StyleType> = StyleType & NestedConditions<StyleType>;

interface NestedConditions<StyleType>
  extends CSSConditions<StyleType & NestedConditions<StyleType>> {}

interface CSSConditions<StyleType>
  extends AtRules<StyleType>,
    ToplevelSelectors<StyleType> {}

// -- Selectors ---------------------------------------------------------------
export interface ToplevelSelectors<StyleType>
  extends ComplexSelectors<StyleType>,
    SimplyNestedSelectors<StyleType>,
    PseudoSelectorMap<StyleType> {}
interface ComplexSelectors<StyleType> {
  /**
   * Toplevel complex selector.
   *
   * @see https://vanilla-extract.style/documentation/styling/#complex-selectors
   */
  [selector: `${string}&${string}`]: StyleType;
}
interface SimplyNestedSelectors<StyleType> {
  [selector: `:${string}` | `[${string}`]: StyleType;
}
type PseudoSelectorMap<StyleType> = {
  [key in CamelPseudos]?: StyleType;
};

// -- At Rules ----------------------------------------------------------------
export type AtRulesKeywords = "media" | "supports" | "container" | "layer";
interface AtRules<StyleType>
  extends NestedAtRules<StyleType>,
    TopLevelAtRules<StyleType> {}

type NestedAtRules<StyleType> = {
  [key in AtRulesKeywords as `@${key}`]?: {
    [query: string]: StyleType;
  };
};

type TopLevelAtRules<StyleType> = {
  [key in AtRulesKeywords as `@${key} ${string}`]?: StyleType;
};

// == Anonymous At-Rules ======================================================
interface WithAnonymousCSSProperties
  extends Omit<ResolvedProperties, AnonymousPropertyKey>,
    AnonymousProperty {}
export interface AnonymousProperty {
  /**
   * The **`animation-name`** CSS property specifies the names of one or more `@keyframes` at-rules that describe the animation to apply to an element. Multiple `@keyframe` at-rules are specified as a comma-separated list of names. If the specified name does not match any `@keyframe` at-rule, no properties are animated.
   *
   * **Syntax**: `[ none | <keyframes-name> ]#`
   *
   * **Initial value**: `none`
   *
   * | Chrome  | Firefox | Safari  |  Edge  |   IE   |
   * | :-----: | :-----: | :-----: | :----: | :----: |
   * | **43**  | **16**  |  **9**  | **12** | **10** |
   * | 3 _-x-_ | 5 _-x-_ | 4 _-x-_ |        |        |
   *
   * @see https://developer.mozilla.org/docs/Web/CSS/animation-name
   */
  animationName?:
    | Property.AnimationName
    | { [key in CSSKeyframeFromTo]?: CSSComplexProperties };

  /**
   * The **`font-family`** CSS property specifies a prioritized list of one or more font family names and/or generic family names for the selected element.
   *
   * **Syntax**: `[ <family-name> | <generic-family> ]#`
   *
   * **Initial value**: depends on user agent
   *
   * | Chrome | Firefox | Safari |  Edge  |  IE   |
   * | :----: | :-----: | :----: | :----: | :---: |
   * | **1**  |  **1**  | **1**  | **12** | **3** |
   *
   * @see https://developer.mozilla.org/docs/Web/CSS/font-family
   */
  fontFamily?: Property.FontFamily | GlobalFontFaceRule;
}
export type AnonymousPropertyKey = keyof AnonymousProperty;

export interface ResolvedProperties
  extends Properties<number | NonNullableString> {}

type CSSKeyframeFromTo =
  | "from"
  | "to"
  | `${IntRange<1, 10>}0%`
  | `${number & NonNullable<unknown>}%`;

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, assertType } = import.meta.vitest;

  describe.concurrent("CSS Rules", () => {
    it("Unitless", () => {
      assertType<CSSRule>({
        // cast to pixels
        padding: 10,
        marginTop: 25,

        // unitless properties
        flexGrow: 1,
        opacity: 0.5
      });
    });

    it("Vendor Prefix", () => {
      assertType<CSSRule>({
        WebkitTapHighlightColor: "rgba(0, 0, 0, 0)"
      });
    });

    it("Fallback styles", () => {
      assertType<CSSRule>({
        overflow: ["auto", "overlay"]
      });
    });

    it("Merge Values", () => {
      assertType<CSSRule>({
        boxShadow$: ["inset 0 0 10px #555", "0 0 20px black"],
        transform_: ["scale(2)", "rotate(15deg)"]
      });
    });

    it("CSS var", () => {
      assertType<CSSRule>({
        // Toplevel Var
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
      });
    });

    it("Simple Pseudo selectors", () => {
      assertType<CSSRule>({
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
      });
    });

    it("Nested properties", () => {
      assertType<CSSRule>({
        padding: {
          BlockEnd: 3,
          Right: "20px"
        },
        background: {
          Color: "red",
          Image: "none"
        }
      });
    });

    it("Property conditions", () => {
      assertType<CSSRule>({
        background: {
          base: "red",
          _hover: "green",
          "[disabled]": "blue",
          "nav li > &": "black",
          "@media (prefers-color-scheme: dark)": "white",
          "@media": {
            "screen and (min-width: 768px)": "grey"
          }
        }
      });
    });

    it("Simply toplevel selectors", () => {
      assertType<CSSRule>({
        // Pseudo selectors
        ":hover:active": {
          color: "red"
        },

        // Attribute selectors
        "[disabled]": {
          color: "green"
        },
        '[href^="https://"][href$=".org"]': {
          color: "blue"
        }
      });
    });

    it("Complex selectors", () => {
      assertType<CSSRule>({
        // Toplevel complex selectors
        "&:hover:not(:active)": {
          border: "2px solid aquamarine"
        },
        "nav li > &": {
          textDecoration: "underline"
        },

        // selectors Properties
        selectors: {
          "&:hover:not(:active)": {
            border: "2px solid aquamarine"
          },
          "nav li > &": {
            textDecoration: "underline"
          }
        }
      });
    });

    it("Nested selectors", () => {
      assertType<CSSRule>({
        "nav li > &": {
          color: "red",
          _hover: {
            color: "green"
          },
          "&:hover:not(:active)": {
            color: "blue"
          },
          ":root[dir=rtl] &": {
            color: "black"
          }
        }
      });
    });

    it("AtRules", () => {
      assertType<CSSRule>({
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
      });
    });

    it("Anonymous AtRules", () => {
      // Original Properties
      assertType<CSSRule>({
        animationName: "none",
        fontFamily: "sans-serif"
      });

      // Anonymous AtRules
      assertType<CSSRule>({
        animationName: {
          from: {
            opacity: 0
          },
          "50%": {
            opacity: 0.3
          },
          to: {
            opacity: 1
          }
        },
        fontFamily: {
          fontFamily: "Pretendard",
          fontWeight: 900,
          src$: [
            "local('Pretendard Regular')",
            "url(../../../packages/pretendard/dist/web/static/woff2/Pretendard-Regular.woff2) format('woff2')",
            "url(../../../packages/pretendard/dist/web/static/woff/Pretendard-Regular.woff) format('woff')"
          ]
        }
      });
    });

    it("Complex Nested Properties & Selectors & AtRules", () => {
      // It's a just test sample.
      // In practice, don't write code like this.
      assertType<CSSRule>({
        "&:hover:not(:active)": {
          // Anonymous AtRules
          animationName: {
            from: {
              opacity: 0,

              // Nested properties
              background: {
                Color: {
                  // Property conditions
                  base: "red",
                  _hover: "green",

                  // Nested at rules
                  "@media (prefers-color-scheme: dark)": {
                    "@media (prefers-reduced-motion)": "blue",
                    "@media (min-width: 900px)": "yellow",

                    "@layer framework": {
                      "@layer": {
                        layout: "black",
                        utilities: {
                          base: "white",
                          _hover: "grey"
                        }
                      }
                    }
                  }
                },
                Image: "none"
              }
            },
            to: {
              opacity: 1
            }
          }
        }
      });
    });
  });

  describe.concurrent("Complex CSS Rules", () => {
    it("className", () => {
      assertType<ComplexCSSRule>(["className1", "className2"]);
    });

    it("function", () => {
      assertType<ComplexCSSRule>([
        () => "className1",
        (_arg: number) => "className2",
        (_arg: CSSRule, _debugId: string) => "className3"
      ]);
    });

    it("CSS Rules", () => {
      assertType<ComplexCSSRule>({
        padding: 10,
        marginTop: 25
      });
      assertType<ComplexCSSRule>([
        {
          padding: 10,
          marginTop: 25
        },
        {
          color: "red",
          _hover: {
            color: "blue"
          }
        }
      ]);
    });

    it("Complex", () => {
      assertType<ComplexCSSRule>([
        "className1",
        "className2",
        () => "className3",
        (_arg: number) => "className4",
        (_arg: CSSRule, _debugId: string) => "className5",
        {
          padding: 10,
          marginTop: 25
        },
        {
          color: "red",
          _hover: {
            color: "blue"
          }
        }
      ]);
    });
  });
}
