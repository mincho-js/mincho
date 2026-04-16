
import { defineRules } from "@mincho-js/css";

export const preset = defineRules({
  properties: {
    color: true,
    display: true
  }
});

export const { css } = preset;

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});
