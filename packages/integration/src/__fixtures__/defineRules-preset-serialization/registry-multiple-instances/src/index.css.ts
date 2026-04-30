import { defineRules } from "@mincho-js/css";

const primaryPresetOwner = defineRules({
  properties: {
    color: true,
    display: true
  }
});

const secondaryPresetOwner = defineRules({
  properties: {
    padding: true,
    margin: true
  }
});

export const { css, preset } = primaryPresetOwner;
export const secondaryPreset = secondaryPresetOwner.preset;

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});

export const secondaryShared = secondaryPresetOwner.css({
  padding: 17,
  margin: 7
});
