import { defineRules } from "@mincho-js/css";
import { display as aDisplay } from "@mincho-js-proof/diamond-a";
import { color as bColor, preset as bPreset } from "@mincho-js-proof/diamond-b";
import { color as cColor, preset as cPreset } from "@mincho-js-proof/diamond-c";

export const owner = defineRules({
  debugId: "package-diamond",
  presets: [bPreset, cPreset],
  properties: {
    color: true,
    display: true,
    padding: true
  }
});

const { css, cx } = owner;

export const selected = css({ color: "rebeccapurple" });
export const inherited = css({ display: "flex" });
export const local = css({ padding: 13 });
export const localWithInherited = css({
  color: "rebeccapurple",
  display: "flex",
  padding: 13
});
export const acceptsHistoricalB = cx(bColor);
export const acceptsHistoricalC = cx(cColor);
export const acceptsBothHistorical = cx(bColor, cColor);
export const acceptsImportedA = cx(aDisplay);
export const importedB = bColor;
export const importedC = cColor;
export const importedA = aDisplay;
export const preset = owner.preset;
