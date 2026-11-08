import { defineRules } from "@mincho-js/css";
import { vars } from "./theme.css";

const { rules, cx } = defineRules({
  properties: {
    color: vars.color,
    backgroundColor: vars.color,
    paddingInline: vars.space,
    paddingBlock: vars.space,
    borderRadius: { rounded: vars.radius },
    border: ["none"],
    fontWeight: [600, 700],
    minHeight: [44],
    cursor: ["pointer"]
  },
  shortcuts: {
    px: "paddingInline",
    py: "paddingBlock"
  }
});

export { cx };

export const button = rules({
  base: {
    color: "ink",
    border: "none",
    borderRadius: "rounded",
    fontWeight: 700,
    minHeight: 44,
    cursor: "pointer"
  },
  variants: {
    tone: {
      accent: { backgroundColor: "accent" },
      soft: { backgroundColor: "surface" }
    },
    size: {
      small: { px: "md", py: "sm" },
      large: { px: "lg", py: "md" }
    }
  },
  defaultVariants: { tone: "accent", size: "small" }
});
