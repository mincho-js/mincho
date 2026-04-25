import type {
  DefineRulesCtx,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./types.js";
import { createDefineRulesRuntime } from "./runtime.js";

export const createDefineRulesCssRuntime = <
  const Properties extends DefineRulesProperties,
  const Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  config: DefineRulesCtx<Properties, Shortcuts>
) => {
  return createDefineRulesRuntime(config, {
    preservePresetReference: true
  }).css;
};
