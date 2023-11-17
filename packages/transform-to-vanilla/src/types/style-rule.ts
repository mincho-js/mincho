import type { ComplexStyleRule, StyleRule } from "@vanilla-extract/css";

export type ComplexCSSRule = ComplexStyleRule;
export type CSSRule = StyleRule;

export type VanillaStyleArray = Exclude<ComplexStyleRule, StyleRule>;
export type VanillaClassNames = Exclude<VanillaStyleArray[number], StyleRule>;
