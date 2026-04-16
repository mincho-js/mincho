import { defineRules } from "@mincho-js/css";

const { css, preset } = defineRules({
  properties: {
    color: true,
    display: true
  }
});

export { css, preset };

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});
