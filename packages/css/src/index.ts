export type {
  CollectStyleDeclarationsOptions,
  CollectedStyleDeclaration,
  ConditionAliasMap,
  ConditionAliasValue,
  CSSProperties,
  ComplexCSSRule,
  GlobalCSSRule,
  CSSRule,
  NormalizedCondition
} from "@mincho-js/transform-to-vanilla";

export type { Adapter, FileScope } from "@vanilla-extract/css";
export {
  assignVars,
  composeStyles,
  createContainer,
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

export { globalCss, css, selector } from "./css/index.js";
export type { CSSRuleWith } from "./css/types.js";
export { rules } from "./rules/index.js";
export type {
  VariantStyle,
  RulesVariants as RecipeVariants,
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
export { globalTheme, theme } from "./theme/index.js";
export type {
  Theme,
  ThemeValue,
  TokenDefinition,
  TokenColorDefinition,
  TokenColorValue,
  TokenDimensionDefinition,
  TokenDimensionValue,
  TokenFontFamilyDefinition,
  TokenFontFamilyValue,
  TokenFontWeightDefinition,
  TokenFontWeightValue,
  TokenDurationDefinition,
  TokenDurationValue,
  TokenCubicBezierDefinition,
  TokenNumberDefinition,
  ResolveTheme
} from "./theme/types.js";
export { cx } from "./classname/index.js";
export type { ClassValue, Cx } from "./classname/index.js";
export { defineRules } from "./defineRules/index.js";
export type {
  DefineRulesComplexCssInput,
  DefineRulesCondition,
  DefineRulesConditionAliasKey,
  DefineRulesConditions,
  DefineRulesCss,
  DefineRulesCssInput,
  DefineRulesCtx,
  DefineRulesEmptyConditions,
  DefineRulesInlineCssInput,
  DefineRulesPresetArtifactV3,
  DefineRulesPresetArtifactV4,
  DefineRulesPresetCompiledEntry,
  DefineRulesPresetCompiledKnownEntry,
  DefineRulesPresetCompiledSegment,
  DefineRulesPresetCompiledUnknownEntry,
  DefineRulesPresetInput,
  DefineRulesPresetMap,
  DefineRulesPresetWriteKey,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./defineRules/types.js";
export type { DefineRulesConditionObject } from "./defineRules/conditions.js";
