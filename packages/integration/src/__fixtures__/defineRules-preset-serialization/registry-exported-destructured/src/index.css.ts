import { defineRules } from "@mincho-js/css";

export const { css, preset } = defineRules({
  properties: {
    color: true,
    display: true
  }
});

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});
