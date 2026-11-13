import { theme, defineRules, css as literalCss } from "@mincho-js/css";
import { themeSpec } from "@mincho-js/tailwind";
import { tailwindTokens } from "@mincho-js/preset-tailwind/tokens";

const tokens = {
  ...tailwindTokens,
  colors: {
    ...tailwindTokens.colors,
    brand: "rebeccapurple",
    ink: "#17231a",
    paper: "#fff"
  }
};

export const [light, vars, contract] = theme(tokens);
export const [dark] = theme.extends(contract, {
  ...tokens,
  colors: { ...tokens.colors, ink: "#fff", paper: "#17231a" }
});

const { css, rules } = defineRules(themeSpec(vars));

export const button = rules({
  base: css({
    px: 4,
    py: 2,
    rounded: "lg",
    fontWeight: "semibold",
    cursor: "pointer",
    _focusVisible: { outline: "2px solid currentColor", outlineOffset: 4 }
  }),
  variants: {
    tone: {
      solid: css({ bg: "brand", color: "white", _hover: { bg: "violet-700" } }),
      soft: css({
        bg: "violet-100",
        color: "violet-900",
        _hover: { bg: "violet-200" }
      })
    },
    size: {
      regular: { fontSize: "base" },
      large: { fontSize: "lg", px: 6, py: 3 }
    }
  },
  defaultVariants: { tone: "solid", size: "regular" }
});

// Effects compose through native literal CSS, using the same theme variables.
export const effects = literalCss({
  filter_: [
    "blur(0px)",
    ...vars.dropShadows.DEFAULT.map((value) => `drop-shadow(${value})`)
  ],
  boxShadow$: [vars.shadows.sm, vars.insetShadows.xs]
});
