import { defineRules } from "@mincho-js/css";

function createPresetOwner() {
  function createNestedPresetOwner() {
    return defineRules({
      properties: {
        color: true,
        display: true
      }
    });
  }

  return createNestedPresetOwner();
}

const presetOwner = createPresetOwner();
export const { css, preset } = presetOwner;

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});
