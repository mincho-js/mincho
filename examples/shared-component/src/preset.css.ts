import { defineRules } from "@mincho-js/css";

export const { cx, css, preset } = defineRules({
  debugId: "sharedPreset",
  conditions: {
    mobile: {},
    tablet: "screen and (min-width: 768px)",
    desktop: {
      "@media": "screen and (min-width: 1024px)",
      selector: "&[data-layout=wide]"
    }
  },
  properties: {
    background: true,
    color: true,
    padding: true,
    borderRadius: true,
    display: true,
    fontSize: true
  }
});

export const sharedCardClassName = cx(
  css({
    background: "rebeccapurple",
    color: {
      base: "white",
      _desktop: "lavender"
    },
    padding: 16,
    borderRadius: 12,
    display: "block",
    _tablet: {
      fontSize: 16
    },
    fontSize: {
      _desktop: 20
    }
  }),
  "shared-card"
);
