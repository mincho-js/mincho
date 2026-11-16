import mincho = require("@mincho-js/css");
import presets = require("@mincho-js/preset-theme-ui");
import contracts = require("@mincho-js/theme-ui");
import source = require("@mincho-js/preset-theme-ui/presets");
import config = require("@mincho-js/preset-theme-ui/config");

const pluginOptions: import("@mincho-js/vite").MinchoVitePluginOptions = {
  extractCalls: config.extractCalls
};
void pluginOptions;

const text = presets.system.rules({
  variants: { size: { display: { fontSize: 6 } } }
});
text({ size: "display" });
presets.system.css({ color: "accent", mx: -2 });
const mode: string = presets.systemModeClasses.dark;
void mode;
const [, vars, contract] = mincho.theme(source.systemTokens);
mincho.theme.extends(contract, source.systemModes.dark);
mincho
  .defineRules(contracts.themeSpec(presets.systemVars))
  .css({ color: "accent" });

const definition = mincho.defineRules(contracts.themeSpec(vars));
definition.css({ bg: "muted", px: 2, _sm: { color: "primary" } });

// @ts-expect-error The published CommonJS definition preserves token keys.
presets.system.css({ color: "missing" });
// @ts-expect-error Consumer recipes preserve their own variants.
text({ size: "missing" });

// @ts-expect-error CommonJS declarations retain the same token constraints.
definition.css({ color: "unknown" });

const compatible: contracts.Theme = source.systemTokens;
void compatible;

const widened: contracts.Theme = {};
const optionalTokens = contracts.normalizeTheme(widened).tokens;
// @ts-expect-error A widened theme may omit the border scale.
const borders: object = optionalTokens.borders;
void borders;

type OptionalColor = NonNullable<typeof optionalTokens.colors>["primary"];
const literalColor: OptionalColor = "blue";
const missingColor: OptionalColor = undefined;
void literalColor;
void missingColor;

const aliased = contracts.normalizeTheme({
  space: Object.assign([0, 4] as const, { sm: 4 }),
  fontSizes: Object.assign([12, 16], { body: 16 })
});
const [, aliasedVars] = mincho.theme(aliased.tokens);
const aliasedRules = mincho.defineRules(contracts.themeSpec(aliasedVars));
aliasedRules.css({ p: "sm", fontSize: "body" });
// @ts-expect-error Array methods are not scale tokens.
aliasedRules.css({ p: "map" });

const arrayVars = Object.assign([aliasedVars.space[0]], {
  sm: aliasedVars.space.sm
});
const arrayRules = mincho.defineRules(
  contracts.themeSpec({ space: arrayVars })
);
arrayRules.css({ p: "sm", m: "-sm" });
// @ts-expect-error Array methods are not variable aliases.
arrayRules.css({ p: "map" });

const tupleVars = Object.assign([vars.space[0], vars.space[1]] as const, {
  sm: vars.space[2]
});
const tupleRules = mincho.defineRules(
  contracts.themeSpec({ space: tupleVars })
);
tupleRules.css({ p: 1, mx: -1, gap: "sm", m: "-sm" });
// @ts-expect-error Fixed tuples expose only their known indices.
tupleRules.css({ p: 2 });
// @ts-expect-error Negative tokens are limited to known indices as well.
tupleRules.css({ mx: -2 });

const emptyRules = mincho.defineRules(
  contracts.themeSpec({ space: [] as const })
);
// @ts-expect-error An empty tuple has no indexed tokens.
emptyRules.css({ p: 0 });
arrayRules.css({ p: 99 });

declare const maybeBreakpoints: { wide: string } | undefined;
const uncertainConfig = contracts.themeSpec(vars, maybeBreakpoints);
// @ts-expect-error An optional breakpoint argument may select only defaults.
uncertainConfig.conditions.wide["@media"];
if ("wide" in uncertainConfig.conditions) {
  const wide: string = uncertainConfig.conditions.wide["@media"];
  void wide;
}
const defaultConfig = contracts.themeSpec(vars, undefined);
const small: string = defaultConfig.conditions.sm["@media"];
void small;
// @ts-expect-error Explicit undefined selects the default condition keys.
defaultConfig.conditions.wide;

const broadModes = contracts.normalizeTheme(widened).modes;
const possibleMode:
  | ReturnType<typeof contracts.normalizeTheme<contracts.Theme>>["tokens"]
  | undefined = broadModes.dark;
void possibleMode;
// @ts-expect-error A broadly typed source may not contain this mode.
const requiredMode: object = broadModes.dark;
void requiredMode;
// Optional modes may introduce colors that are absent without the mode.
declare const optionalModeSource: {
  colors: { text: string; modes?: { dark: { accent: string } } };
};
const optionalModeTheme = contracts.normalizeTheme(optionalModeSource);
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
const dynamicConfig = contracts.themeSpec(vars, dynamicBreakpoints);
const maybeSmall: { "@media": string } | undefined =
  dynamicConfig.conditions.sm;
void maybeSmall;
// @ts-expect-error The dynamic array may be empty.
dynamicConfig.conditions.sm["@media"];
mincho.defineRules(dynamicConfig);

declare const namedBreakpoints: Record<string, string>;
const namedConfig = contracts.themeSpec(vars, namedBreakpoints);
// @ts-expect-error An arbitrary dictionary key may be absent.
namedConfig.conditions.wide["@media"];
mincho.defineRules(namedConfig);

const fixedConfig = contracts.themeSpec(vars, ["40em", "52em"] as const);
const fixedSmall: string = fixedConfig.conditions.sm["@media"];
const fixedMedium: string = fixedConfig.conditions.md["@media"];
void fixedSmall;
void fixedMedium;
// @ts-expect-error The fixed tuple has no third breakpoint.
fixedConfig.conditions.lg;

declare const mixedBreakpoints: Record<string, string> & { wide: string };
const mixedConfig = contracts.themeSpec(vars, mixedBreakpoints);
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
