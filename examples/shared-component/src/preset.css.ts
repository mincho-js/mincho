import { defineRules } from "@mincho-js/css";

export const { css, cx, preset } = defineRules({
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
