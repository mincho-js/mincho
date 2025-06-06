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
} from "./css/index.js";
export { rules, recipe } from "./rules/index.js";
export { createRuntimeFn } from "./rules/createRuntimeFn.js";
export type {
  VariantStyle,
  RulesVariants,
  RecipeVariants,
  RuntimeFn,
  VariantGroups,
  PatternOptions,
  VariantSelection,
  ComplexPropDefinitions,
  PropTarget,
  VariantDefinitions,
  ConditionalVariants,
  VariantObjectSelection,
  ResolveComplex
} from "./rules/types.js";

export type { CSSProperties, ComplexCSSRule, GlobalCSSRule, CSSRule };
export type ComplexStyleRule = ComplexCSSRule;
export type GlobalStyleRule = GlobalCSSRule | ComplexCSSRule;
export type StyleRule = CSSRule;
