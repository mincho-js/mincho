import { globalStyle, keyframes, style } from "@mincho-js/css"

globalStyle("#root", {
  maxWidth: "1280px",
  margin: "0 auto",
  padding: "2rem",
  textAlign: "center",
});

export const react = style({
});
const logoSpin = keyframes({
  "from": {
    transform: "rotate(0deg)",
  },
  "to": {
    transform: "rotate(360deg)",
  },
});

export const logo = style({
  height: "6em",
  padding: "1.5em",
  willChange: "filter",
  transition: "filter 300ms",

  _hover: {
    filter: "drop-shadow(002em#646cffaa)",
  },
  selectors: {
    [`&${react}:hover`]: {
      filter: "drop-shadow(002em#61dafbaa)",
    },
  },

  "@media (prefers-reduced-motion: no-preference)": {
    "a:nth-of-type(2) &": {
      animation: `${logoSpin} infinite 20s linear`,
    },
  },
});

export const card = style({
  padding: "2em",
});

export const readTheDocs = style({
  color: "#888",
});

