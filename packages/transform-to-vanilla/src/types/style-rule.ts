import type { StyleRule, fontFace } from "@vanilla-extract/css";
import type { Properties, Property, NonNullableString } from "csstype";
import type {
  SpacePropertiesKey,
  CommaPropertiesKey,
  NestedPropertiesMap
} from "@mincho/css-additional-types";
import type { SimplePseudos, CamelPseudos } from "./simple-pseudo";
import type { IntRange, ExcludeArray, Arr, PartialDeepMerge } from "./utils";

// == Vanilla Extract Inteface ================================================
// https://github.com/vanilla-extract-css/vanilla-extract/blob/master/packages/css/src/types.ts
export type VanillaStyleRuleKey = keyof StyleRule;
export type VanillaStyleRuleValue = StyleRule[VanillaStyleRuleKey];

export type VanillaStyleArray = Array<StyleRule | ClassNames>;
export type VanillaClassNames = ClassNames;

// == Interface ===============================================================
export type ComplexCSSRule = CSSRule | Array<ComplexCSSItem>;
export type ComplexCSSItem = CSSRule | ClassNames;

export type CSSRule = Partial<
  StyleWithNestedProperties & WithQueries<StyleWithNestedProperties>
>;
export type GlobalCSSRule = CSSPropertiesWithVars &
  WithQueries<CSSPropertiesWithVars>;

export type CSSRuleKey = keyof CSSRule;
export type CSSRuleValue = CSSRule[CSSRuleKey];

export type ClassNames = string | Array<ClassNames>;

// == Style with Nested Properties ============================================
export type StyleWithNestedProperties = PartialDeepMerge<
  StyleWithSelectors,
  NestedCSSProperties
>;
export type NestedCSSProperties = {
  [Key in keyof NestedPropertiesMap]?: {
    [NestedKey in keyof NestedPropertiesMap[Key]]?: StyleWithSelectors[Extract<
      NestedPropertiesMap[Key][NestedKey],
      keyof StyleWithSelectors
    >];
  };
};

// == Style with Selectors ====================================================
// -- Main --------------------------------------------------------------------
export type StyleWithSelectors = CSSPropertiesAndPseudos & SelectorProperties;

// -- Psesudo -----------------------------------------------------------------
type CSSPropertiesAndPseudos = CSSPropertiesWithVars & PseudoProperties;

type PseudoProperties = {
  [key in SimplePseudos | CamelPseudos]?: CSSPropertiesWithVars;
};

// -- Selector ----------------------------------------------------------------
export type SelectorProperties = ToplevelSelector & SelectorProperty;

type SelectorProperty = {
  /**
   * More complex rules can be written using the `selectors` key.
   *
   * @see https://vanilla-extract.style/documentation/styling/#complex-selectors
   */
  selectors?: ComplexSelectorMap;
};
type ToplevelSelector = Partial<ComplexSelectorMap> & Partial<SimplyNestedMap>;

type ComplexSelectorMap = {
  [selector: `${string}&${string}`]: SelectorValues;
};
type SimplyNestedMap = {
  [selector in `:${string}` | `[${string}`]: SelectorValues;
};
type SelectorValues = CSSPropertiesWithVars &
  WithQueries<CSSPropertiesWithVars>;

// == CSS Properties ==========================================================
// -- Main --------------------------------------------------------------------
export type CSSPropertiesWithVars = CSSComplexProperties &
  VarProperty &
  TopLevelVar;
export type VarProperty = {
  /**
   * Custom properties are scoped to the element(s) they are declared on, and participate in the cascade: the value of such a custom property is that from the declaration decided by the cascading algorithm.
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/--*
   */
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

type CSSTypeProperties = WithAnonymousCSSProperty & ContainerProperties;

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

// == Anonymous At-Rules ======================================================
type WithAnonymousCSSProperty = Omit<ResolvedProperties, AnonymousPropertyKey> &
  Partial<AnonymousProperty>;

export type AnonymousProperty = {
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
  animationName:
    | Property.AnimationName
    | { [key in CSSKeyframeFromTo]: CSSComplexProperties };

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
  fontFamily:
    | Property.FontFamily
    | ({
        /**
         * The **`font-family`** CSS descriptor sets the font family for a font specified in an [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
         *
         * **Syntax**: `<family-name>`
         *
         * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-family
         */
        fontFamily: string;
      } & FontFaceRule &
        Partial<FontFaceMergeRule>);
};
export type AnonymousPropertyKey = keyof AnonymousProperty;

type ResolvedProperties = Properties<number | NonNullableString>;

type CSSKeyframeFromTo =
  | "from"
  | "to"
  | `${IntRange<1, 10>}0%`
  | `${number & NonNullable<unknown>}%`;

type FontFaceRule = ExcludeArray<Parameters<typeof fontFace>[0]>;
type RequiredFontFaceRule = Required<FontFaceRule>;
type FontFaceMergeRule = {
  /**
   * The **font-stretch** CSS descriptor allows authors to specify a normal, condensed, or expanded face for the fonts specified in the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   *
   * **Syntax**: `<'font-stretch'>{1,2} `
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-stretch
   */
  fontStretch_: Arr<Exclude<RequiredFontFaceRule["fontStretch"], "normal">, 2>;

  /**
   * The **`font-style`** CSS descriptor allows authors to specify font styles for the fonts specified in the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   *
   * **Syntax**: `oblique <angle [-90deg,90deg]>?]`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-style
   */
  fontStyle_: ["oblique", ...`${number}${Angle}`[]];

  /**
   * The **`font-weight`** CSS descriptor allows authors to specify font weights for the fonts specified in the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule. The [`font-weight`](https://developer.mozilla.org/en-US/docs/Web/CSS/font-weight) property can separately be used to set how thick or thin characters in text should be displayed.
   *
   * **Syntax**: `<font-weight-absolute>{1,2}`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-weight
   */
  fontWeight_: RequiredFontFaceRule["fontWeight"][];

  /**
   * The **`font-feature-settings`** CSS descriptor allows you to define the initial settings to use for the font defined by the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule. You can further use this descriptor to control typographic font features such as ligatures, small caps, and swashes, for the font defined by `@font-face`.
   *
   * **Syntax**: `<feature-tag-value>#`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-feature-settings
   */
  fontFeatureSettings$: FeatureTagValue;
  /**
   * The **`font-feature-settings`** CSS descriptor allows you to define the initial settings to use for the font defined by the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule. You can further use this descriptor to control typographic font features such as ligatures, small caps, and swashes, for the font defined by `@font-face`.
   *
   * **Syntax**: `<feature-tag-value>#`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-feature-settings
   */
  MozFontFeatureSettings$: FeatureTagValue;

  /**
   * The **`font-variation-settings`** CSS descriptor allows authors to specify low-level OpenType or TrueType font variations in the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   *
   * **Syntax**: `[ <string> <number> ]#`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-variation-settings
   */
  fontVariationSettings$: `${string} ${number}`[];

  /**
   * The **`src`** CSS descriptor for the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule specifies the resource containing font data.
   *
   * **Syntax**: `<font-src-list>`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/src
   */
  src$: FontFaceSrc[];

  /**
   * The **`unicode-range`** CSS descriptor sets the specific range of characters to be used from a font defined using the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule and made available for use on the current page.
   *
   * **Syntax**: `<urange>`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/unicode-range
   */
  unicodeRange$: `U+${string}`[];
};

type Angle = "deg" | "grad" | "rad" | "turn";
type FeatureTagValue = (NonNullableString &
  `${string} ${number | "on" | "off"}`)[];
type FontFaceSrc =
  | `local(${string})`
  | `url(${string})`
  | `url(${string}) format(${string})`
  | `url(${string}) tech(${string})`
  | `url(${string}) format(${string}) tech(${string})`;

// == Tests ====================================================================
if (import.meta.vitest) {
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
          blockEnd: 3,
          right: "20px"
        },
        background: {
          color: "red",
          image: "none"
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
  });
}
