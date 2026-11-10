import type { Properties, Property } from "@mincho-js/csstype";

import type { shortcuts, scaleProperties } from "./scales.js";

/** Theme UI's data format, expressed with Mincho's CSS property types. */
export type CSSProperties = Properties<string | number>;

export type ThemeUIEmpty = undefined | null | false;

export type ResponsiveStyleValue<T> =
  T | ThemeUIEmpty | readonly (T | ThemeUIEmpty)[];

export interface ObjectWithDefault<T> {
  __default?: T;
}

type ShortcutProperty<T> = T extends readonly (infer P)[]
  ? ShortcutProperty<P>
  : T extends keyof typeof shortcuts
    ? ShortcutProperty<(typeof shortcuts)[T]>
    : T;

type AliasProperties = {
  [K in keyof typeof shortcuts]?: CSSProperties[ShortcutProperty<
    (typeof shortcuts)[K]
  >];
};

type ScaleProperty =
  (typeof scaleProperties)[keyof typeof scaleProperties][number];

type StyleValue<T> = ResponsiveStyleValue<
  T | ObjectWithDefault<T> | readonly T[]
>;

type AnyCSSValue = NonNullable<CSSProperties[keyof CSSProperties]>;

export type StylePropertyValue<T, TTheme = Theme> =
  | StyleValue<T>
  | ((theme: TTheme) => StyleValue<T>)
  | ThemeUIStyleObject<TTheme>;

export type ThemeUICSSProperties<TTheme = Theme> = {
  [K in keyof (CSSProperties & AliasProperties)]?: StylePropertyValue<
    | (CSSProperties & AliasProperties)[K]
    | (K extends ScaleProperty | keyof AliasProperties ? string : never),
    TTheme
  >;
};

/** Nested selectors and at-rules use the same style object as declarations. */
export type ThemeUICSSObject<TTheme = Theme> = ThemeUICSSProperties<TTheme> & {
  [selector: string]: StylePropertyValue<AnyCSSValue, TTheme>;
  variant?: string;
  label?: string;
};

export type ThemeUIStyleObject<TTheme = Theme> =
  ThemeUICSSObject<TTheme> | ((theme: TTheme) => ThemeUICSSObject<TTheme>);

/** Scales keep the original arrays, named entries, and nested token groups. */
export interface ScaleDict<T> {
  [name: string]: T | readonly T[] | ScaleDict<T> | undefined;
  [index: number]: T;
}

export type Scale<T> = readonly T[] | ScaleDict<T>;

export type NestedScale<T> = Scale<T>;

// Mincho's opaque fallbacks also accept non-primitive values. Token scales
// retain the strings and numbers supported by normalization.
type PrimitiveCSSValue<T> = T & (string | number);
type CSSScale<T> = Scale<PrimitiveCSSValue<T>>;
type ColorValue = PrimitiveCSSValue<Property.Color>;

export interface ColorMode extends ScaleDict<ColorValue> {
  background?: ColorValue | NestedScale<ColorValue>;
  text?: ColorValue | NestedScale<ColorValue>;
  primary?: ColorValue | NestedScale<ColorValue>;
  secondary?: ColorValue | NestedScale<ColorValue>;
  accent?: ColorValue | NestedScale<ColorValue>;
  highlight?: ColorValue | NestedScale<ColorValue>;
  muted?: ColorValue | NestedScale<ColorValue>;
}

export type ColorModesScale = ColorMode & {
  modes?: Record<string, ColorMode>;
};

export interface ThemeScales {
  space?: CSSScale<Property.Margin<string | number>>;
  fontSizes?: CSSScale<Property.FontSize<number>>;
  fonts?: CSSScale<Property.FontFamily>;
  fontWeights?: CSSScale<Property.FontWeight>;
  lineHeights?: CSSScale<Property.LineHeight<string | number>>;
  letterSpacings?: CSSScale<Property.LetterSpacing<string | number>>;
  sizes?: CSSScale<
    Property.Height<string | number> | Property.Width<string | number>
  >;
  borders?: CSSScale<Property.Border>;
  borderStyles?: CSSScale<Property.BorderStyle>;
  borderWidths?: CSSScale<Property.BorderWidth<string | number>>;
  radii?: CSSScale<Property.BorderRadius<string | number>>;
  shadows?: CSSScale<Property.BoxShadow>;
  zIndices?: CSSScale<Property.ZIndex>;
  opacities?: CSSScale<Property.Opacity>;
  transitions?: CSSScale<Property.Transition>;
  colors?: ColorModesScale;
}

/** Provider options remain metadata for applications to interpret. */
export interface ThemeUIConfig {
  useCustomProperties?: boolean;
  /** Preserves the legacy spelling used in upstream preset metadata. */
  initialColorMode?: string;
  initialColorModeName?: string;
  printColorModeName?: string;
  useRootStyles?: boolean;
  useColorSchemeMediaQuery?: "system" | "initial" | boolean;
  useBorderBox?: boolean;
  useLocalStorage?: boolean;
}

type DocumentElement =
  | "tr"
  | "th"
  | "td"
  | "em"
  | "strong"
  | "div"
  | "p"
  | "b"
  | "i"
  | "a"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "img"
  | "pre"
  | "code"
  | "ol"
  | "ul"
  | "li"
  | "blockquote"
  | "hr"
  | "table"
  | "delete"
  | "inlineCode"
  | "thematicBreak"
  | "root";

export type ThemeStyles<TTheme = Theme> = {
  [Element in DocumentElement]?: ThemeUIStyleObject<TTheme>;
} & {
  [name: string]: ThemeUIStyleObject<TTheme> | undefined;
};

/** Component variant groups defined by the Theme UI specification. */
export const variantGroups = [
  "grids",
  "buttons",
  "text",
  "links",
  "images",
  "cards",
  "layout",
  "forms",
  "badges",
  "alerts",
  "messages"
] as const;

type ThemeVariants<TTheme> = {
  [Group in (typeof variantGroups)[number]]?: Record<
    string,
    ThemeUIStyleObject<TTheme>
  >;
};

/** Original theme structure; CSS values come from @mincho-js/csstype. */
export interface Theme<TTheme = Record<never, never>>
  extends ThemeScales, ThemeVariants<Theme & TTheme> {
  breakpoints?: readonly string[];
  mediaQueries?: Record<string, string>;
  config?: ThemeUIConfig;
  styles?: ThemeStyles<Theme & TTheme>;
  rawColors?: ColorModesScale;
  colorStyles?: Scale<ThemeUICSSProperties<Theme & TTheme>>;
  textStyles?: Scale<ThemeUICSSProperties<Theme & TTheme>>;

  // Legacy top-level provider settings are preserved as source data.
  useCustomProperties?: boolean;
  initialColorModeName?: string;
  printColorModeName?: string;
  useRootStyles?: boolean;
  useColorSchemeMediaQuery?: boolean;
  useBorderBox?: boolean;
  useLocalStorage?: boolean;
}
