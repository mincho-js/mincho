import type { ComplexStyleRule, StyleRule } from "@vanilla-extract/css";

export type ComplexCSSRule = ComplexStyleRule;
export type CSSRule = StyleRule;

export type StyleRuleKey = keyof StyleRule;
export type StyleRuleValue = StyleRule[StyleRuleKey];
export type CSSRuleKey = keyof CSSRule;
export type CSSRuleValue = CSSRule[CSSRuleKey];

export type VanillaStyleArray = Exclude<ComplexStyleRule, StyleRule>;
export type VanillaClassNames = Exclude<VanillaStyleArray[number], StyleRule>;
