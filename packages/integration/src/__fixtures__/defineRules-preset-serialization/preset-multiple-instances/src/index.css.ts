
import { defineRules } from "@mincho-js/css";

export const sharedPreset = defineRules({
  properties: {
    color: true,
    display: true
  }
});

export const preset = sharedPreset;

export const presetSecondary = defineRules({
  properties: {
    padding: true,
    margin: true
  }
});

const { css: sharedCss } = sharedPreset;
const { css: cssSecondary } = presetSecondary;

export { sharedCss };

export const css = sharedCss;

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});

export const secondaryShared = cssSecondary({
  padding: 17,
  margin: 7
});
