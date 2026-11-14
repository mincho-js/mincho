/** Values shared by complete Tailwind themes and their resolved Mincho variables. */
export type TailwindScales = {
  colors: Readonly<Record<string, string>>;
  spacing: string;
  fonts: Readonly<Record<string, string>>;
  fontSizes: Readonly<Record<string, { size: string; lineHeight: string }>>;
  fontWeights: Readonly<Record<string, string>>;
  letterSpacings: Readonly<Record<string, string>>;
  lineHeights: Readonly<Record<string, string>>;
  radii: Readonly<Record<string, string>>;
  shadows: Readonly<Record<string, string>>;
  insetShadows: Readonly<Record<string, string>>;
  dropShadows: Readonly<Record<string, readonly string[]>>;
  textShadows: Readonly<Record<string, string>>;
  easings: Readonly<Record<string, string>>;
  animations: Readonly<Record<string, string>>;
  blurs: Readonly<Record<string, string>>;
  perspectives: Readonly<Record<string, string>>;
  aspectRatios: Readonly<Record<string, string>>;
  containers: Readonly<Record<string, string>>;
  maxWidths: Readonly<Record<string, string>>;
  defaults: {
    transitionDuration: string;
    transitionTimingFunction: string;
    fontFamily: string;
    fontFeatureSettings: string;
    fontVariationSettings: string;
    monoFontFamily: string;
    monoFontFeatureSettings: string;
    monoFontVariationSettings: string;
  };
};

export type ColorFamily =
  | "red"
  | "orange"
  | "amber"
  | "yellow"
  | "lime"
  | "green"
  | "emerald"
  | "teal"
  | "cyan"
  | "sky"
  | "blue"
  | "indigo"
  | "violet"
  | "purple"
  | "fuchsia"
  | "pink"
  | "rose"
  | "slate"
  | "gray"
  | "zinc"
  | "neutral"
  | "stone"
  | "mauve"
  | "olive"
  | "mist"
  | "taupe";
export type ColorShade =
  50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;
export type ColorName = `${ColorFamily}-${ColorShade}` | "black" | "white";

/** The default 4.3.5 token contract; CSS classes are created by native theme(). */
export type TailwindTokens = Pick<TailwindScales, "spacing" | "defaults"> & {
  colors: Record<ColorName, string>;
  fonts: Record<"sans" | "serif" | "mono", string>;
  fontSizes: Record<
    | "xs"
    | "sm"
    | "base"
    | "lg"
    | "xl"
    | "2xl"
    | "3xl"
    | "4xl"
    | "5xl"
    | "6xl"
    | "7xl"
    | "8xl"
    | "9xl",
    { size: string; lineHeight: string }
  >;
  fontWeights: Record<
    | "thin"
    | "extralight"
    | "light"
    | "normal"
    | "medium"
    | "semibold"
    | "bold"
    | "extrabold"
    | "black",
    string
  >;
  letterSpacings: Record<
    "tighter" | "tight" | "normal" | "wide" | "wider" | "widest",
    string
  >;
  lineHeights: Record<
    "tight" | "snug" | "normal" | "relaxed" | "loose",
    string
  >;
  radii: Record<
    "DEFAULT" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl",
    string
  >;
  shadows: Record<
    "DEFAULT" | "inner" | "2xs" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl",
    string
  >;
  insetShadows: Record<"2xs" | "xs" | "sm", string>;
  dropShadows: Record<
    "DEFAULT" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl",
    string[]
  >;
  textShadows: Record<"2xs" | "xs" | "sm" | "md" | "lg", string>;
  easings: Record<"in" | "out" | "in-out", string>;
  animations: Record<"spin" | "ping" | "pulse" | "bounce", string>;
  blurs: Record<
    "DEFAULT" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl",
    string
  >;
  perspectives: Record<
    "dramatic" | "near" | "normal" | "midrange" | "distant",
    string
  >;
  aspectRatios: Record<"video", string>;
  containers: Record<
    | "3xs"
    | "2xs"
    | "xs"
    | "sm"
    | "md"
    | "lg"
    | "xl"
    | "2xl"
    | "3xl"
    | "4xl"
    | "5xl"
    | "6xl"
    | "7xl",
    string
  >;
  maxWidths: Record<"prose", string>;
};
