import { defineRules } from "@mincho-js/css";

function createPresetOwner() {
  return defineRules({
    properties: {
      color: true,
      display: true
    }
  });
}

const presetOwner = createPresetOwner();
export const { css, preset } = presetOwner;

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});
