import type {
  CSSProperties,
  ComplexCSSRule,
  GlobalCSSRule,
  CSSRule
} from "@mincho-js/transform-to-vanilla";

export type { Adapter, FileScope } from "@vanilla-extract/css";
export {
  assignVars,
  composeStyles,
  createContainer,
  createGlobalTheme,
  createGlobalThemeContract,
  createTheme,
  createThemeContract,
  createVar,
  fallbackVar,
  fontFace,
  generateIdentifier,
  globalFontFace,
  globalKeyframes,
  globalLayer,
  keyframes,
  layer
} from "@vanilla-extract/css";

export {
  globalCss,
  globalStyle,
  css,
  style,
  cssVariants,
  styleVariants
} from "./css";
export { rules, recipe } from "./rules";
export type { RulesVariants, RecipeVariants, RuntimeFn } from "./rules/types";

export type { CSSProperties, ComplexCSSRule, GlobalCSSRule, CSSRule };
export type ComplexStyleRule = ComplexCSSRule;
export type GlobalStyleRule = GlobalCSSRule;
export type StyleRule = CSSRule;
