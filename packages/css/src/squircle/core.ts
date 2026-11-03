/** Pure geometry and CSS declarations: no React, DOM or stylesheet registration. */
export {
  getSquirclePath,
  resolveGeometry as getSquircleGeometry,
  finiteNonnegative,
  normalizeRadius,
  normalizeSmoothing
} from "./geometry.js";
export type {
  SquircleOptions,
  Geometry as SquircleGeometry
} from "./geometry.js";
export {
  getMaskAsset as getSquircleMask,
  createMaskAsset as createSquircleMask
} from "./mask-cache.js";
export type { MaskAsset as SquircleMaskAsset } from "./mask-cache.js";
export {
  getSquircleStyle,
  squircleMaskBase,
  fixedSquircleSize
} from "./styles.js";
