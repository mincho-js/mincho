import { defineRules } from "@mincho-js/css";
import type { DefineRulesResult } from "@mincho-js/css";
import { themeSpec } from "@mincho-js/tailwind";
import type { ThemeSpec, defaultBreakpoints } from "@mincho-js/tailwind";

import { vars } from "./theme.css.js";

// Keep the native definition as an authoring module: numeric spacing, sizing
// and lineClamp use resolvers that are evaluated by the consumer's compiler.
type Spec = ThemeSpec<typeof vars, typeof defaultBreakpoints>;
type Definition = DefineRulesResult<
  Spec["properties"],
  Spec["shortcuts"],
  Spec["conditions"],
  typeof vars
>;

const definition = /* @__PURE__ */ defineRules<
  Spec["properties"],
  Spec["shortcuts"],
  Spec["conditions"],
  typeof vars
>(/* @__PURE__ */ themeSpec(vars));

export const css: Definition["css"] = definition.css;
export const rules: Definition["rules"] = definition.rules;
export const cx: Definition["cx"] = definition.cx;
export const preset: Definition["preset"] = definition.preset;
