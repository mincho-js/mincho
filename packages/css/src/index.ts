import { transform, type ComplexCSSRule } from "@mincho/transform-to-vanilla";
import { style as vStyle } from "@vanilla-extract/css";

export function css(style: ComplexCSSRule) {
  return vStyle(transform(style));
}
export const style = css;
