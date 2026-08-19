import { defineRules } from "@mincho-js/css";
import { preset as cyclePreset } from "@mincho-js-proof/diamond-cycle";

export const owner = defineRules({
  presets: cyclePreset,
  properties: { color: true, display: true }
});
export const preset = owner.preset;
