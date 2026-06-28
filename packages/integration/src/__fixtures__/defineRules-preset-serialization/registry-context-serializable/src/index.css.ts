import { defineRules } from "@mincho-js/css";

const context = {
  palette: {
    brand: "rebeccapurple",
    accent: "hotpink"
  },
  spacing: [0, 8, null, undefined],
  enabled: true
} as const;
Object.defineProperty(context.palette, "resolve", {
  enumerable: false,
  value() {
    return context.palette.brand;
  }
});

const config = {
  context,
  properties: {
    color: true,
    padding: true
  }
};
const { css, preset } = defineRules(config);

export const shared = css({
  color: context.palette.brand,
  padding: context.spacing[1]
});
export { preset };
