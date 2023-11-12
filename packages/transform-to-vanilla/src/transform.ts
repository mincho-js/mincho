import type { ComplexStyleRule } from "@vanilla-extract/css";
import type { ComplexCSSRule, CSSRule } from "./types/style-rule";

// TODO: Need traverse
export function transform(style: ComplexCSSRule): ComplexStyleRule {
  if (Array.isArray(style)) {
    return style.map((eachStyle) => {
      return eachStyle;
    });
  }
  return transformStyle(style);
}

// TODO: Need traverse
function transformStyle(style: CSSRule) {
  return style;
}
