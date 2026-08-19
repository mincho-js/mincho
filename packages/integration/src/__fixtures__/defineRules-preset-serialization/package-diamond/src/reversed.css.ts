import { defineRules } from "@mincho-js/css";
import { color as bColor, preset as bPreset } from "@mincho-js-proof/diamond-b";
import { color as cColor, preset as cPreset } from "@mincho-js-proof/diamond-c";

export const owner = defineRules({
  debugId: "package-diamond-reversed",
  presets: [cPreset, bPreset],
  properties: {
    color: true,
    display: true,
    padding: true
  }
});

const { css, cx } = owner;

export const selected = css({ color: "rebeccapurple" });
export const local = css({ padding: 13 });
export const acceptsBothHistorical = cx(cColor, bColor);
export const importedB = bColor;
export const importedC = cColor;
export const preset = owner.preset;
