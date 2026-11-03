import { style } from "@vanilla-extract/css";
import { getSquircleStyle } from "./styles.js";
import type { SquircleOptions } from "./geometry.js";

export type { SquircleOptions } from "./geometry.js";

/** Build-time class pattern. Use in a .css.ts file with fixed border-box sizes. */
export function squircle(options: SquircleOptions, debugId?: string): string {
  return style(getSquircleStyle(options), debugId);
}
