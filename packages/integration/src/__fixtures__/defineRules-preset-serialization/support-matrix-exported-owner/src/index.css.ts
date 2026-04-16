import { defineRules } from "@mincho-js/css";

export const presetOwner = defineRules({
  properties: {
    color: true,
    display: true
  }
});

export const shared = presetOwner.css({
  color: "rebeccapurple",
  display: "flex"
});
