
import { defineRules } from "@mincho-js/css";

export const preset = defineRules({
  properties: {
    color: true,
    display: true,
    padding: true,
    margin: true
  }
});

const { css } = preset;

export const shared = css({
  color: "goldenrod",
  display: "block"
});
