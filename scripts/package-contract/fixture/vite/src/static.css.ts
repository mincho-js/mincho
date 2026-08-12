import { defineRules } from "@mincho-js/css";
import { preset as diamondPreset } from "@mincho-js-proof/diamond-d/preset";

const local = defineRules({
  debugId: "package-contract-static",
  presets: diamondPreset,
  properties: { color: true }
});

export const staticCx = local.cx(local.css({ color: "navy" }), "package-contract-static");
