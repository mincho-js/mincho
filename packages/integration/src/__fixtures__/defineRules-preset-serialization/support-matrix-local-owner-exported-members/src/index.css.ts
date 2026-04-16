import { defineRules } from "@mincho-js/css";

const presetOwner = defineRules({
  properties: {
    color: true,
    display: true
  }
});

export const css = presetOwner.css;
export const preset = presetOwner.preset;

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});
