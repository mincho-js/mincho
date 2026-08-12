import { defineRules } from "@mincho-js/css";
import { preset as firstPreset } from "@mincho-js-proof/diamond-class-first";
import { preset as secondPreset } from "@mincho-js-proof/diamond-class-second";

export const owner = defineRules({
  presets: [firstPreset, secondPreset],
  properties: { color: true, display: true }
});
export const preset = owner.preset;
