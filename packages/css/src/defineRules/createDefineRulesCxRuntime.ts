import type {
  DefineRulesConditions,
  DefineRulesEmptyConditions,
  DefineRulesCtx,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./types.js";
import { createDefineRulesRuntime } from "./runtime.js";

export const createDefineRulesCxRuntime = <
  const Properties extends DefineRulesProperties,
  const Shortcuts extends DefineRulesShortcuts<
    Properties,
    Shortcuts,
    Conditions
  >,
  const Conditions extends DefineRulesConditions = DefineRulesEmptyConditions
>(
  config: DefineRulesCtx<Properties, Shortcuts, Conditions>
) => {
  return createDefineRulesRuntime(config, {
    preservePresetReference: true
  }).cx;
};
