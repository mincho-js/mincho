import { defineRules } from "@mincho-js/css";

const config = {
  properties: {
    color: true,
    display: true
  }
};

export const { css, preset } = defineRules(config);

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});
