import { css, cx } from "./preset.css.ts";

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
