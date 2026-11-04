import { getMaskAsset } from "./mask-cache.js";
import { resolveGeometry } from "./geometry.js";
import type { SquircleOptions } from "./geometry.js";

/** @internal Shared declarations for the class and React renderers. */
export const squircleMaskBase = {
  boxSizing: "border-box",
  overflow: "hidden"
} as const;

/** @internal Explicit dimensions opt into a fixed border box. */
export function fixedSquircleSize(width?: number, height?: number) {
  return {
    ...(width === undefined ? {} : { width, minWidth: width, maxWidth: width }),
    ...(height === undefined
      ? {}
      : { height, minHeight: height, maxHeight: height })
  };
}

/** @internal `clip-path` value for an SVG path in border-box pixels. */
export function clipPathFromPath(path: string): string {
  return `path("${path}")`;
}

/** Fixed-size declarations, also useful outside React. Numeric lengths are px. */
export function getSquircleStyle(options: SquircleOptions) {
  const geometry = resolveGeometry(options);
  // Path-only use: the cached asset never encodes an SVG image here.
  const asset = getMaskAsset(geometry);
  return {
    ...squircleMaskBase,
    ...fixedSquircleSize(geometry.width, geometry.height),
    borderRadius: asset ? 0 : geometry.radius,
    clipPath: asset ? clipPathFromPath(asset.path) : "none"
  };
}
