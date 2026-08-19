import { defineRules } from "@mincho-js/css";
import { preset as diamondPreset } from "@mincho-js-proof/diamond-d/preset";

export const local = defineRules({
  debugId: "package-contract-dynamic",
  presets: diamondPreset,
  properties: { background: true, color: true, display: true, padding: true }
});

export const card = local.css({ background: "tomato", color: "rebeccapurple", display: "flex", padding: 13 });
export const preset = local.preset;
