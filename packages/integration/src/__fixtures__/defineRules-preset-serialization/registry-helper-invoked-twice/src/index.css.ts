import { defineRules } from "@mincho-js/css";

function createPresetOwner(debugId: string) {
  return defineRules({
    debugId,
    properties: {
      color: true,
      display: true,
      padding: true
    }
  });
}

const firstPresetOwner = createPresetOwner("first");
const secondPresetOwner = createPresetOwner("second");
export const { css, preset } = firstPresetOwner;
export const secondPreset = secondPresetOwner.preset;

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});

export const repeated = secondPresetOwner.css({
  padding: 12
});
