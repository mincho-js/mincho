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

const { css, rules, cx } = defineRules(themeSpec(vars));

export const surface = css({
  color: "ink",
  bg: "paper",
  fontFamily: "sans",
  fontSize: "base",
  p: 6,
  rounded: "2xl",
  shadow: "sm",
  _md: { p: 8 }
});
export const heading = css({
  fontSize: "3xl",
  fontWeight: "bold",
  tracking: "tight",
  _md: { fontSize: "4xl" }
});
export const grid = css({
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: 6,
  _md: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }
});
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
export const actions = css({
  display: "flex",
  flexWrap: "wrap",
  gap: 3,
  mt: 6
});
export const spacing = css({
  p: 1.25,
  mx: -2,
  fontSize: "lg",
  w: "1/2",
  bg: "olive-100"
});
export const clamped = css({
  lineClamp: 2,
  maxWidth: "prose",
  fontSize: "base"
});
export const status = css({
  size: 3,
  rounded: "full",
  bg: "brand",
  animate: "pulse"
});

// Effects compose through native literal CSS, using the same theme variables.
export const effects = literalCss({
  filter_: [
    "blur(0px)",
    ...vars.dropShadows.DEFAULT.map((value) => `drop-shadow(${value})`)
  ],
  boxShadow$: [vars.shadows.sm, vars.insetShadows.xs]
});
export const effectCard = cx(
  css({ p: 4, rounded: "lg", bg: "paper", color: "ink" }),
  effects
);
