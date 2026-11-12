import { theme, defineRules } from "@mincho-js/css";
import { themeSpec, defaultBreakpoints } from "@mincho-js/tailwind";
import type { TailwindTokens } from "@mincho-js/tailwind";
import {
  themeClass,
  vars,
  contract,
  css as presetCss,
  rules as presetRules,
  cx as presetCx,
  preset
} from "@mincho-js/preset-tailwind";
import { tailwindTokens } from "@mincho-js/preset-tailwind/tokens";
import { extractCalls } from "@mincho-js/preset-tailwind/config";

const presetCalls: readonly [
  "css",
  "rules",
  "rules.extends",
  "rules.multiple",
  "cx"
] = extractCalls["@mincho-js/preset-tailwind"];
void presetCalls;

const tokens: TailwindTokens = tailwindTokens;
const className: string = themeClass;
const colorVariable: string = vars.colors["sky-500"];
const container: string = presetCss({ container: true, p: 1.25 });
presetCss([
  {
    bg: { base: "blue-500", _hover: "blue-700" },
    text: "white",
    font: "bold",
    py: 2,
    px: 3
  },
  "rounded"
]);
// @ts-expect-error Conditional token values remain checked.
presetCss({ bg: { _hover: "missing" } });
// @ts-expect-error Familiar aliases do not accept unknown palette keys.
presetCss({ text: "missing" });
const recipeFromPreset = presetRules({
  variants: { tone: { calm: { bg: "sky-50" } } }
});
const composed: string = presetCx(
  themeClass,
  recipeFromPreset({ tone: "calm" })
);
const artifact: import("@mincho-js/css").DefineRulesPresetArtifactV5 = preset;
void [className, colorVariable, container, composed, artifact];
// @ts-expect-error Published APIs retain their token vocabulary.
presetCss({ color: "missing" });
// @ts-expect-error Consumer recipes retain their variant names.
recipeFromPreset({ tone: "missing" });
theme.extends(contract, tokens);

const custom = {
  ...tokens,
  colors: { ...tokens.colors, brand: "rebeccapurple" }
};
const [, customVars] = theme(custom);
const { css, rules } = defineRules(themeSpec(customVars));
css({
  bg: "brand",
  color: "sky-500",
  px: 1.25,
  mx: -2,
  w: "1/2",
  _screen2xl: { p: 8 }
});
css({
  fontSize: "lg",
  leading: "normal",
  blur: "xs",
  dropShadow: "DEFAULT",
  lineClamp: 2
});

// @ts-expect-error A misspelled token must not silently become literal CSS.
css({ color: "missing" });
// @ts-expect-error Named font sizes preserve their vocabulary.
css({ fontSize: "enormous" });
// @ts-expect-error Default breakpoints do not contain arbitrary condition names.
css({ _tablet: { p: 2 } });

const recipe = rules({
  variants: { tone: { solid: { bg: "brand" }, soft: { bg: "sky-50" } } }
});
const selected: string = recipe({ tone: "solid" });
void selected;
// @ts-expect-error Recipe selections retain their exact variant names.
recipe({ tone: "invalid" });

const breakpoint: "96rem" = defaultBreakpoints["2xl"];
void breakpoint;
const named = themeSpec(customVars, { tablet: "48rem", omitted: undefined });
const condition: { "@media": string } = named.conditions.tablet;
void condition;
// @ts-expect-error Explicitly absent conditions do not exist.
named.conditions.omitted;

const dynamic: Record<string, string> = {};
const dynamicSpec = themeSpec(customVars, dynamic);
// @ts-expect-error A widened dictionary does not guarantee any particular condition.
const definite: { "@media": string } = dynamicSpec.conditions.wide;
void definite;
defineRules(dynamicSpec).css({ p: 4 });

const numericSpec = themeSpec(customVars, { 640: "40rem" });
const numericCondition: { "@media": string } = numericSpec.conditions.screen640;
void numericCondition;
defineRules(numericSpec).css({ _screen640: { p: 2 } });

const dynamicNumeric: Record<number, string> = {};
const dynamicNumericSpec = themeSpec(customVars, dynamicNumeric);
// @ts-expect-error A numeric dictionary does not guarantee a particular key either.
const definiteNumeric: { "@media": string } =
  dynamicNumericSpec.conditions.screen640;
void definiteNumeric;
