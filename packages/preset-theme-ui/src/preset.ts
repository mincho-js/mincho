import { defineRules } from "@mincho-js/css";
import type { DefineRulesResult } from "@mincho-js/css";
import { themeSpec } from "@mincho-js/theme-ui";
import type {
  ThemeUIScales,
  ThemeSpec,
  defaultBreakpoints
} from "@mincho-js/theme-ui";

import { baseVars, systemVars, darkVars } from "./themes.css.js";

type Spec<V extends ThemeUIScales> = ThemeSpec<V, typeof defaultBreakpoints>;
type Definition<V extends ThemeUIScales> = DefineRulesResult<
  Spec<V>["properties"],
  Spec<V>["shortcuts"],
  Spec<V>["conditions"],
  V
>;

function bind<V extends ThemeUIScales>(vars: V): Definition<V> {
  return defineRules<
    Spec<V>["properties"],
    Spec<V>["shortcuts"],
    Spec<V>["conditions"],
    V
  >(themeSpec(vars));
}

// The published definitions retain native css/rules/cx/preset capabilities.
// Defining them emits no component styles; consumers choose what to compile.
export const base: Definition<typeof baseVars> =
  /* @__PURE__ */ bind<typeof baseVars>(baseVars);
export const system: Definition<typeof systemVars> =
  /* @__PURE__ */ bind<typeof systemVars>(systemVars);
export const dark: Definition<typeof darkVars> =
  /* @__PURE__ */ bind<typeof darkVars>(darkVars);
