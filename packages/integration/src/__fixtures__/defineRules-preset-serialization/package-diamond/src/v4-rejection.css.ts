import { defineRules } from "@mincho-js/css";
import { preset as legacyPreset } from "@mincho-js-proof/diamond-v4";

export const owner = defineRules({
  presets: legacyPreset,
  properties: { color: true }
});
export const preset = owner.preset;
