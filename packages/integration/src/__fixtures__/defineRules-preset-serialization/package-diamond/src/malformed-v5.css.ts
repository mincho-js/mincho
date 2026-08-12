import { defineRules } from "@mincho-js/css";
import { preset as malformedPreset } from "@mincho-js-proof/diamond-malformed-v5";

export const owner = defineRules({
  presets: malformedPreset,
  properties: { color: true }
});
export const preset = owner.preset;
