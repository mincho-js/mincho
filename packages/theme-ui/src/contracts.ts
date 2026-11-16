/** The upstream presets use nine indexed spacing and font-size tokens. */
export type IndexedScale = {
  [Index in 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8]: string;
};

/** Common token names; Theme Spec's property mappings are shared across contracts. */
export type SharedTokens = {
  space: IndexedScale;
  fonts: { body: string; heading: string; monospace: string };
  fontSizes: IndexedScale;
  fontWeights: { body: number; heading: number };
  lineHeights: { body: number; heading: number };
  colors: {
    text: string;
    background: string;
    primary: string;
    secondary: string;
    muted: string;
  };
};

export type BaseTokens = Omit<SharedTokens, "fontWeights"> & {
  fontWeights: SharedTokens["fontWeights"] & { bold: number };
};

export type SystemTokens = Omit<SharedTokens, "fontWeights" | "colors"> & {
  fontWeights: SharedTokens["fontWeights"] & { display: number };
  colors: SharedTokens["colors"] & {
    highlight: string;
    gray: string;
    accent: string;
  };
};

export type DarkTokens = Omit<SystemTokens, "colors"> & {
  colors: SharedTokens["colors"] & {
    highlight: string;
    gray: string;
    purple: string;
  };
};
