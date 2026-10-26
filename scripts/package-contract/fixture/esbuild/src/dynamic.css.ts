import { defineRules } from "@mincho-js/css";
import { definitions as parentDefinitions } from "@mincho-js-proof/diamond-a/rules";
import { preset as diamondPreset } from "@mincho-js-proof/diamond-d/preset";

const local = defineRules({
  debugId: "package-contract-esbuild",
  presets: diamondPreset,
  properties: { background: true, color: true, display: true, padding: true }
});

export const card = local.css({
  background: "tomato",
  color: "rebeccapurple",
  display: "flex",
  padding: 13
});
export const preset = local.preset;

const extendedDefinitions = defineRules.extends(parentDefinitions, {
  properties: { display: ["grid"] }
});
export const extendedAtomic = extendedDefinitions.css({ display: "grid" });
