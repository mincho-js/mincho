import { defineRules } from "@mincho-js/css";

export const presetOwner = (() => {
  return defineRules({
    properties: {
      color: true,
      display: true
    }
  });
})();

export const { css, preset } = presetOwner;

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});
