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
export type CSSPropertiesWithVars = CSSComplexProperties & {
  vars?: {
    [key: string]: string;
  };
};

export type CSSComplexProperties = CSSProperties & CSSMergeProperties;

// -- Properties --------------------------------------------------------------
export type CSSProperties = {
  [Property in keyof CSSTypeProperties]:
    | CSSTypeProperties[Property]
    | CSSVarFunction
    | Array<CSSVarFunction | CSSTypeProperties[Property]>;
};

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
// TODO: Top level at rules
export type WithQueries<StyleType> = StyleType & AllQueries<StyleType>;

// -- Queries -----------------------------------------------------------------
interface AllQueries<StyleType>
  extends MediaQueries<StyleType & AllQueries<StyleType>>,
    FeatureQueries<StyleType & AllQueries<StyleType>>,
    ContainerQueries<StyleType & AllQueries<StyleType>>,
    Layers<StyleType & AllQueries<StyleType>> {}

export type MediaQueries<StyleType> = Query<"@media", StyleType>;
export type FeatureQueries<StyleType> = Query<"@supports", StyleType>;
export type ContainerQueries<StyleType> = Query<"@container", StyleType>;
export type Layers<StyleType> = Query<"@layer", StyleType>;

// -- Utils -------------------------------------------------------------------
type Query<Key extends string, StyleType> = {
  [key in Key]?: {
    [query: string]: Omit<StyleType, Key>;
  };
};

// == Others ==================================================================
export interface CSSKeyframes {
  [time: string]: CSSComplexProperties;
}

// https://github.com/vanilla-extract-css/vanilla-extract/blob/master/packages/private/src/types.ts
export type CSSVarFunction =
  | `var(--${string})`
  | `var(--${string}, ${string | number})`;

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expectTypeOf } = import.meta.vitest;

  describe.concurrent("CSS Queries", () => {
    it("CSS Query", () => {
      type ButtonStyles = {
        color: string;
        fontSize: number;
        borderRadius: number;
      };

      type ButtonQuery = Query<"Button", ButtonStyles>;
      const button: ButtonQuery = {
        Button: {
          anyQuery: {
            color: "red",
            fontSize: 3,
            borderRadius: 3
          }
        }
      };
      expectTypeOf<ButtonQuery>().toMatchTypeOf(button);

      type AllQueriesStyle = WithQueries<ButtonStyles>;
      const allQueries: AllQueriesStyle = {
        color: "red",
        fontSize: 3,
        borderRadius: 3,
        "@media": {
          anyQuery: {
            color: "blue",
            fontSize: 5,
            borderRadius: 5
          }
        }
      };
      expectTypeOf<AllQueriesStyle>().toMatchTypeOf(allQueries);
    });
  });
}
