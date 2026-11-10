import { theme, defineRules } from "@mincho-js/css";
import {
  system as compiled,
  systemVars,
  systemModeClasses
} from "@mincho-js/preset-theme-ui";
import { themeSpec, normalizeTheme } from "@mincho-js/theme-ui";
import { systemTokens, systemModes } from "@mincho-js/preset-theme-ui/presets";
import { extractCalls } from "@mincho-js/preset-theme-ui/config";
import type { MinchoVitePluginOptions } from "@mincho-js/vite";

const pluginOptions: MinchoVitePluginOptions = { extractCalls };
void pluginOptions;

const text = compiled.rules({
  variants: { size: { display: { fontSize: 6 } } }
});
text({ size: "display" });
const mode: string = systemModeClasses.dark;
void mode;
// @ts-expect-error Definitions expose native APIs, not source theme values.
compiled.tokens;
// @ts-expect-error System tokens do not implement the base contract's bold key.
const invalidBase: import("@mincho-js/theme-ui").BaseTokens = systemTokens;
void invalidBase;
const [, vars, contract] = theme(systemTokens);
defineRules(themeSpec(systemVars)).css({ color: "accent", mx: -2 });
theme.extends(contract, systemModes.dark);

const definition = defineRules(themeSpec(vars));
definition.css({ color: "accent", px: 2, mx: -1, _md: { p: 4 } });

compiled.css({ color: "accent", mx: -2, _md: { p: 4 } });
compiled.rules.extends(text, {
  variants: { active: { true: { color: "primary" } } }
});
const extended = defineRules.extends(compiled, {
  properties: { display: ["grid", "flex"] }
});
extended.css({ color: "primary", display: "grid" });
const artifact: import("@mincho-js/css").DefineRulesPresetArtifactV5 =
  compiled.preset;
void artifact;
// @ts-expect-error Published definitions retain the original token vocabulary.
compiled.css({ color: "unknown" });

// @ts-expect-error Unknown token.
definition.css({ color: "unknown" });
// @ts-expect-error Invalid scale index.
definition.css({ p: 99 });
// @ts-expect-error Padding has no generated negative tokens.
definition.css({ p: -1 });
// @ts-expect-error Unknown preset variant.
text({ size: "unknown" });

const compatible: import("@mincho-js/theme-ui").Theme = systemTokens;
void compatible;

const widened: import("@mincho-js/theme-ui").Theme = {};
const optionalTokens = normalizeTheme(widened).tokens;
// @ts-expect-error A widened theme may omit the border scale.
const borders: object = optionalTokens.borders;
void borders;

type OptionalColor = NonNullable<typeof optionalTokens.colors>["primary"];
const literalColor: OptionalColor = "blue";
const missingColor: OptionalColor = undefined;
void literalColor;
void missingColor;

const aliased = normalizeTheme({
  space: Object.assign([0, 4] as const, { sm: 4 }),
  fontSizes: Object.assign([12, 16], { body: 16 })
});
const [, aliasedVars] = theme(aliased.tokens);
const aliasedRules = defineRules(themeSpec(aliasedVars));
aliasedRules.css({ p: "sm", fontSize: "body" });
// @ts-expect-error Array methods are not scale tokens.
aliasedRules.css({ p: "map" });

const arrayVars = Object.assign([aliasedVars.space[0]], {
  sm: aliasedVars.space.sm
});
const arrayRules = defineRules(themeSpec({ space: arrayVars }));
arrayRules.css({ p: "sm", m: "-sm" });
// @ts-expect-error Array methods are not variable aliases.
arrayRules.css({ p: "map" });

const tupleVars = Object.assign([vars.space[0], vars.space[1]] as const, {
  sm: vars.space[2]
});
const tupleRules = defineRules(themeSpec({ space: tupleVars }));
tupleRules.css({ p: 1, mx: -1, gap: "sm", m: "-sm" });
// @ts-expect-error Fixed tuples expose only their known indices.
tupleRules.css({ p: 2 });
// @ts-expect-error Negative tokens are limited to known indices as well.
tupleRules.css({ mx: -2 });

const emptyRules = defineRules(themeSpec({ space: [] as const }));
// @ts-expect-error An empty tuple has no indexed tokens.
emptyRules.css({ p: 0 });
arrayRules.css({ p: 99 });

declare const maybeBreakpoints: { wide: string } | undefined;
const uncertainConfig = themeSpec(vars, maybeBreakpoints);
// @ts-expect-error An optional breakpoint argument may select only defaults.
uncertainConfig.conditions.wide["@media"];
if ("wide" in uncertainConfig.conditions) {
  const wide: string = uncertainConfig.conditions.wide["@media"];
  void wide;
}
const defaultConfig = themeSpec(vars, undefined);
const small: string = defaultConfig.conditions.sm["@media"];
void small;
// @ts-expect-error Explicit undefined selects the default condition keys.
defaultConfig.conditions.wide;

const broadModes = normalizeTheme(widened).modes;
const possibleMode:
  | ReturnType<
      typeof normalizeTheme<import("@mincho-js/theme-ui").Theme>
    >["tokens"]
  | undefined = broadModes.dark;
void possibleMode;
// @ts-expect-error A broadly typed source may not contain this mode.
const requiredMode: object = broadModes.dark;
void requiredMode;
// Optional modes may introduce colors that are absent without the mode.
declare const optionalModeSource: {
  colors: { text: string; modes?: { dark: { accent: string } } };
};
const optionalModeTheme = normalizeTheme(optionalModeSource);
const optionalAccent: string | undefined =
  optionalModeTheme.tokens.colors.accent;
const optionalModeAccent: string | undefined =
  optionalModeTheme.modes.dark?.colors.accent;
void optionalAccent;
void optionalModeAccent;
// @ts-expect-error The optional mode may not contribute an accent token.
const requiredAccent: string = optionalModeTheme.tokens.colors.accent;
void requiredAccent;

// Dynamic collections do not guarantee any particular breakpoint key.
declare const dynamicBreakpoints: string[];
const dynamicConfig = themeSpec(vars, dynamicBreakpoints);
const maybeSmall: { "@media": string } | undefined =
  dynamicConfig.conditions.sm;
void maybeSmall;
// @ts-expect-error The dynamic array may be empty.
dynamicConfig.conditions.sm["@media"];
defineRules(dynamicConfig);

declare const namedBreakpoints: Record<string, string>;
const namedConfig = themeSpec(vars, namedBreakpoints);
// @ts-expect-error An arbitrary dictionary key may be absent.
namedConfig.conditions.wide["@media"];
defineRules(namedConfig);

const fixedConfig = themeSpec(vars, ["40em", "52em"] as const);
const fixedSmall: string = fixedConfig.conditions.sm["@media"];
const fixedMedium: string = fixedConfig.conditions.md["@media"];
void fixedSmall;
void fixedMedium;
// @ts-expect-error The fixed tuple has no third breakpoint.
fixedConfig.conditions.lg;

declare const mixedBreakpoints: Record<string, string> & { wide: string };
const mixedConfig = themeSpec(vars, mixedBreakpoints);
const requiredWide: string = mixedConfig.conditions.wide["@media"];
void requiredWide;
// @ts-expect-error Only the explicitly named key is guaranteed.
mixedConfig.conditions.unknown["@media"];

// Explicitly omitted conditions never register a native alias.
type OptionalConditionAlias =
  import("@mincho-js/css").DefineRulesConditionAliasKey<{
    active: string;
    possible?: string;
    omitted: undefined;
    absent?: undefined;
  }>;
const activeAlias: OptionalConditionAlias = "_active";
const possibleAlias: OptionalConditionAlias = "_possible";
void activeAlias;
void possibleAlias;
// @ts-expect-error A condition with no possible value is not registered.
const omittedAlias: OptionalConditionAlias = "_omitted";
void omittedAlias;
// @ts-expect-error An optional undefined-only entry is not registered either.
const absentAlias: OptionalConditionAlias = "_absent";
void absentAlias;
