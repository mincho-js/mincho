import { defineRules } from "@mincho-js/css";

export const { css: sharedCss, preset: sharedPreset } = defineRules({
  properties: {
    color: true,
    display: true
  }
});

export const shared = sharedCss({
  color: "rebeccapurple",
  display: "flex"
});
