
import { defineRules } from "@mincho-js/css";

export const { css: atomicCss } = defineRules({
  properties: {
    color: true,
    display: true
  }
});

export const shared = atomicCss({
  color: "rebeccapurple",
  display: "flex"
});
