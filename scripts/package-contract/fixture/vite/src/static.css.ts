import { defineRules } from "@mincho-js/css";
import { definitions as parentDefinitions } from "@mincho-js-proof/diamond-a/rules";
import { preset as diamondPreset } from "@mincho-js-proof/diamond-d/preset";

const local = defineRules({
  debugId: "package-contract-static",
  presets: diamondPreset,
  properties: { color: true }
});

export const staticCx = local.cx(
  local.css({ color: "navy" }),
  "package-contract-static"
);

const extendedDefinitions = defineRules.extends(parentDefinitions, {
  properties: { display: ["grid"] }
});
export const extendedAtomic = extendedDefinitions.css({ display: "grid" });
