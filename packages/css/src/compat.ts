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
  globalCss as globalStyle,
  css as style,
  cssMultiple as styleVariants,
  selector
} from "./css/index.js";
export type { CSSRuleWith as StyleRuleWith } from "./css/types.js";

export type {
  VariantStyle,
  RulesVariants,
  RuntimeFn,
  VariantGroups,
  PatternOptions,
  VariantSelection,
  ComplexPropDefinitions,
  PropTarget,
  VariantDefinitions,
  ConditionalVariants,
  VariantObjectSelection,
  ResolveComplex,
  PropDefinitionOutput
} from "./rules/types.js";
export { rules as recipe } from "./rules/index.js";

export type {
  CSSProperties,
  ComplexCSSRule as ComplexStyleRule,
  CSSRule as StyleRule,
  GlobalCSSRule as GlobalStyleRule
} from "@mincho-js/transform-to-vanilla";
