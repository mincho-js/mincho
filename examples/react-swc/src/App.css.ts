import { css } from "@examples/shared-component";
import { css as localCss, globalCss, keyframes } from "@mincho-js/css";

globalCss("#root", {
  maxWidth: "1280px",
  margin: "0 auto",
  padding: "2rem",
  textAlign: "center",
});

export const react = localCss({
});
const logoSpin = keyframes({
  "from": {
    transform: "rotate(0deg)",
  },
  "to": {
    transform: "rotate(360deg)",
  },
});

export const logo = localCss({
  height: "6em",
  padding: "1.5em",
  willChange: "filter",
  transition: "filter 300ms",

  _hover: {
    filter: "drop-shadow(0 0 2em #646cffaa)",
  },
  selectors: {
    [`&${react}:hover`]: {
      filter: "drop-shadow(0 0 2em #61dafbaa)",
    },
  },

  "@media (prefers-reduced-motion: no-preference)": {
    "a:nth-of-type(2) &": {
      animation: `${logoSpin} infinite 20s linear`,
    },
  },
});

export const card = localCss({
  padding: "2em",
});

export const sharedCardConsumer = css({
  display: "block",
});

export const readTheDocs = localCss({
  color: "#888",
});
