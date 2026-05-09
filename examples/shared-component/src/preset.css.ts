import { defineRules } from "@mincho-js/css";

export const { cx, css, preset } = defineRules({
  debugId: "sharedPreset",
  properties: {
    background: true,
    color: true,
    padding: true,
    borderRadius: true,
    display: true
  }
});

export const sharedCardClassName = cx(
  css({
    background: "rebeccapurple",
    color: "white",
    padding: 16,
    borderRadius: 12,
    display: "block"
  }),
  "shared-card"
);
