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
export { getVarName } from "./utils.js";
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
export type { ThemeContract, ThemeResult } from "./theme/index.js";
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
export type { ClassPrimitive, ClassValue, Cx } from "./classname/index.js";
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
  DefineRulesPresetArtifactV5,
  DefineRulesPresetAtomV5,
  DefineRulesPresetNodeV5,
  DefineRulesPresetCompiledEntry,
  DefineRulesPresetCompiledKnownEntry,
  DefineRulesPresetCompiledSegment,
  DefineRulesPresetCompiledUnknownEntry,
  DefineRulesPropertyValuesEntries,
  DefineRulesPropertyValuesEntry,
  DefineRulesPropertyValuesResult,
  DefineRulesPresetInput,
  PresetAtomId,
  PresetContentHash,
  PresetNodeId,
  PresetOriginId,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./defineRules/types.js";
export type { DefineRulesConditionObject } from "./defineRules/conditions.js";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect, expectTypeOf } = import.meta.vitest;

  describe("getVarName export", () => {
    it("is available from the root barrel", async () => {
      const { getVarName } = await import("./index.js");

      expect(typeof getVarName).toBe("function");
      expect(getVarName("var(--my-var-name, 1px)")).toBe("--my-var-name");
      expect(getVarName("--my-var-name")).toBe("--my-var-name");
      expectTypeOf(getVarName).returns.toEqualTypeOf<
        import("@mincho-js/transform-to-vanilla").PureCSSVarKey
      >();
    });
  });
}
