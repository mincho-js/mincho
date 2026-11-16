import type { CSSProperties } from "@mincho-js/css";

/** Compound styles from Tailwind 4.3.5, expressed as native CSS declarations. */
export const utilityStyles = {
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0px",
    margin: "-1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0px"
  },
  notSrOnly: {
    position: "static",
    width: "auto",
    height: "auto",
    padding: "0px",
    margin: "0px",
    overflow: "visible",
    clipPath: "none",
    whiteSpace: "normal"
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  }
} as const satisfies Record<string, CSSProperties>;

export function lineClamp(lines: number | "none"): CSSProperties {
  if (lines === "none")
    return {
      overflow: "visible",
      display: "block",
      WebkitBoxOrient: "horizontal",
      WebkitLineClamp: "unset"
    };

  if (!Number.isInteger(lines) || lines < 1)
    throw new Error("lineClamp expects a positive integer or 'none'");

  return {
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: lines
  };
}
