import type {
  DefineRulesConditions,
  DefineRulesEmptyConditions,
  DefineRulesCtx,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./types.js";
import { createDefineRulesRuntime } from "./runtime.js";

export const createDefineRulesCssRuntime = <
  const Properties extends DefineRulesProperties,
  const Shortcuts extends DefineRulesShortcuts<
    Properties,
    Shortcuts,
    Conditions
  >,
  const Conditions extends DefineRulesConditions = DefineRulesEmptyConditions,
  const Context = undefined
>(
  config: DefineRulesCtx<Properties, Shortcuts, Conditions, Context>
) => {
  return createDefineRulesRuntime<Properties, Shortcuts, Conditions, Context>(
    config
  ).css;
};
