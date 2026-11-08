import { createDefineRulesCssRuntime } from "./createDefineRulesCssRuntime.js";
import { createDefineRulesRules } from "./rules.js";
import type {
  DefineRulesConditions,
  DefineRulesCssInput,
  DefineRulesCtx,
  DefineRulesEmptyConditions,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./types.js";

/** Rehydrate an exported authoring factory; its generated recipes use the
 * ordinary lightweight rules runtime, without this authoring dependency.
 */
export function createDefineRulesRulesRuntime<
  const Properties extends DefineRulesProperties,
  const Shortcuts extends DefineRulesShortcuts<
    Properties,
    Shortcuts,
    Conditions
  >,
  const Conditions extends DefineRulesConditions = DefineRulesEmptyConditions,
  const Context = undefined
>(config: DefineRulesCtx<Properties, Shortcuts, Conditions, Context>) {
  return createDefineRulesRules<
    DefineRulesCssInput<Properties, Shortcuts, Conditions>,
    Context
  >(createDefineRulesCssRuntime(config));
}
