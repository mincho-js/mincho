import { createPresetOwner } from "./helper";

const presetOwner = createPresetOwner();
export const { css, preset } = presetOwner;

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});
