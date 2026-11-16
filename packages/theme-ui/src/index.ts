export type {
  IndexedScale,
  SharedTokens,
  BaseTokens,
  SystemTokens,
  DarkTokens
} from "./contracts.js";

export type {
  CSSProperties,
  ThemeUIEmpty,
  ResponsiveStyleValue,
  ObjectWithDefault,
  StylePropertyValue,
  ThemeUICSSProperties,
  ThemeUICSSObject,
  ThemeUIStyleObject,
  ScaleDict,
  Scale,
  NestedScale,
  ColorMode,
  ColorModesScale,
  ThemeScales,
  ThemeStyles,
  ThemeUIConfig,
  Theme
} from "./schema.js";

export { themeSpec } from "./config.js";
export { defaultBreakpoints, scaleProperties, shortcuts } from "./scales.js";
export type { ScaleName } from "./scales.js";
export type {
  Breakpoints,
  ThemeUIScales,
  ThemeUIProperties,
  ThemeUIConditions,
  ThemeSpec,
  VariableScale
} from "./config.js";

export { normalizeTheme, defaultScales } from "./normalize.js";
export type {
  NormalizedTokens,
  NormalizedTheme,
  ColorModeNames
} from "./normalize.js";
