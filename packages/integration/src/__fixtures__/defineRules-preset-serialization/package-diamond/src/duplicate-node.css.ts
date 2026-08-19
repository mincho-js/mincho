import { defineRules } from "@mincho-js/css";
import { preset as bPreset } from "@mincho-js-proof/diamond-b";

export const owner = defineRules({
  presets: [bPreset, bPreset],
  properties: { color: true, display: true }
});
export const preset = owner.preset;
