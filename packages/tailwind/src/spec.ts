import { defineRules } from "@mincho-js/css";
import type { CSSProperties } from "@mincho-js/css";

import type { TailwindScales } from "./contracts.js";
import { defaultBreakpoints, breakpointEntries } from "./breakpoints.js";
import type { Breakpoints, BreakpointConditions } from "./breakpoints.js";
import { utilityStyles, lineClamp } from "./utilities.js";

const globals = {
  inherit: "inherit",
  initial: "initial",
  unset: "unset",
  revert: "revert",
  "revert-layer": "revert-layer"
} as const;

// Literal layout and decoration values complement the token-backed scales.
const nativeProperties = [
  "display",
  "position",
  "isolation",
  "overflow",
  "overflowX",
  "overflowY",
  "flex",
  "flexDirection",
  "flexWrap",
  "flexGrow",
  "flexShrink",
  "alignItems",
  "alignSelf",
  "alignContent",
  "justifyContent",
  "justifyItems",
  "justifySelf",
  "order",
  "gridTemplateColumns",
  "gridTemplateRows",
  "gridTemplateAreas",
  "gridAutoFlow",
  "gridAutoColumns",
  "gridAutoRows",
  "gridColumn",
  "gridRow",
  "border",
  "cursor",
  "textDecoration",
  "textDecorationLine",
  "textDecorationStyle",
  "textDecorationThickness",
  "textUnderlineOffset",
  "textUnderlinePosition",
  "outline",
  "outlineStyle",
  "outlineWidth",
  "outlineOffset"
] as const;

const colorProperties = [
  "color",
  "backgroundColor",
  "borderColor",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "borderBlockColor",
  "borderBlockStartColor",
  "borderBlockEndColor",
  "borderInlineColor",
  "borderInlineStartColor",
  "borderInlineEndColor",
  "outlineColor",
  "textDecorationColor",
  "accentColor",
  "caretColor",
  "columnRuleColor"
] as const satisfies readonly (keyof CSSProperties)[];

const spacingProperties = [
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "paddingBlock",
  "paddingBlockStart",
  "paddingBlockEnd",
  "paddingInline",
  "paddingInlineStart",
  "paddingInlineEnd",
  "gap",
  "columnGap",
  "rowGap",
  "scrollPadding",
  "scrollPaddingTop",
  "scrollPaddingRight",
  "scrollPaddingBottom",
  "scrollPaddingLeft",
  "scrollPaddingBlock",
  "scrollPaddingBlockStart",
  "scrollPaddingBlockEnd",
  "scrollPaddingInline",
  "scrollPaddingInlineStart",
  "scrollPaddingInlineEnd"
] as const satisfies readonly (keyof CSSProperties)[];

const signedSpacingProperties = [
  "margin",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "marginBlock",
  "marginBlockStart",
  "marginBlockEnd",
  "marginInline",
  "marginInlineStart",
  "marginInlineEnd",
  "inset",
  "insetBlock",
  "insetBlockStart",
  "insetBlockEnd",
  "insetInline",
  "insetInlineStart",
  "insetInlineEnd",
  "top",
  "right",
  "bottom",
  "left",
  "textIndent",
  "scrollMargin",
  "scrollMarginTop",
  "scrollMarginRight",
  "scrollMarginBottom",
  "scrollMarginLeft",
  "scrollMarginBlock",
  "scrollMarginBlockStart",
  "scrollMarginBlockEnd",
  "scrollMarginInline",
  "scrollMarginInlineStart",
  "scrollMarginInlineEnd"
] as const satisfies readonly (keyof CSSProperties)[];

const radiusProperties = [
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "borderStartStartRadius",
  "borderStartEndRadius",
  "borderEndStartRadius",
  "borderEndEndRadius"
] as const satisfies readonly (keyof CSSProperties)[];

type MappedValues<T, Value> = { [K in keyof T]: Value };

function mapValues<T extends object, Value>(
  values: T,
  transform: (value: T[keyof T]) => Value
): MappedValues<T, Value> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, transform(value)])
  ) as MappedValues<T, Value>;
}

/** Numbers use Tailwind's spacing multiplier; CSS length strings remain literal. */
function spacing(unit: string, negative = false) {
  return (value: number | string): string => {
    if (typeof value === "string") return value === "px" ? "1px" : value;

    if (
      !Number.isFinite(value) ||
      (!negative && value < 0) ||
      !Number.isInteger(value * 4)
    )
      throw new Error(
        "Tailwind spacing expects finite quarter-step multipliers"
      );

    return `calc(${unit} * ${value})`;
  };
}

function sizing(
  unit: string,
  named: Readonly<Record<string, string>>,
  axis: "w" | "h"
) {
  const length = spacing(unit);
  const keywords: Record<string, string> = {
    full: "100%",
    min: "min-content",
    max: "max-content",
    fit: "fit-content",
    screen: axis === "w" ? "100vw" : "100vh",
    svw: "100svw",
    lvw: "100lvw",
    dvw: "100dvw",
    svh: "100svh",
    lvh: "100lvh",
    dvh: "100dvh",
    lh: "1lh"
  };

  return (value: number | string): string => {
    if (typeof value !== "string") return length(value);
    if (Object.hasOwn(keywords, value)) return keywords[value];
    if (Object.hasOwn(named, value)) return named[value];
    if (/^-?[\d.]+\/-?[\d.]+$/.test(value)) {
      const [numerator, denominator] = value.split("/").map(Number);

      if (
        numerator < 0 ||
        denominator <= 0 ||
        !Number.isFinite(numerator / denominator)
      )
        throw new Error(`Invalid Tailwind size fraction: ${value}`);

      return `calc(${numerator} / ${denominator} * 100%)`;
    }

    return length(value);
  };
}

/** Bind Tailwind styles to native theme variables. Construct this inside .css.ts. */
export function themeSpec<const V extends TailwindScales>(
  vars: V
): ThemeSpec<V, typeof defaultBreakpoints>;
export function themeSpec<
  const V extends TailwindScales,
  const B extends Breakpoints
>(vars: V, breakpoints: B): ThemeSpec<V, B>;
export function themeSpec<
  const V extends TailwindScales,
  const B extends Breakpoints
>(vars: V, breakpoints?: B) {
  return createSpec(vars, breakpoints ?? defaultBreakpoints);
}

function createSpec<V extends TailwindScales, B extends Breakpoints>(
  vars: V,
  breakpoints: B
) {
  const values = <K extends keyof TailwindScales>(key: K): V[K] => vars[key];

  const colors = {
    ...globals,
    ...values("colors"),
    transparent: "transparent",
    current: "currentColor"
  };
  const radii = {
    ...globals,
    DEFAULT: "0.25rem",
    none: "0px",
    full: "calc(infinity * 1px)",
    ...values("radii")
  };
  const widths = sizing(vars.spacing, values("containers"), "w");
  const heights = sizing(vars.spacing, values("containers"), "h");
  const entries = breakpointEntries(breakpoints ?? defaultBreakpoints);
  const conditions = Object.fromEntries(
    entries.map(({ name, width }) => [
      name,
      { "@media": `(width >= ${width})` }
    ])
  ) as BreakpointConditions<B>;
  const container = {
    width: "100%",
    "@media": Object.fromEntries(
      entries.map(({ width }) => [`(width >= ${width})`, { maxWidth: width }])
    )
  };

  return {
    context: vars,
    conditions,
    properties: {
      ...defineRules.propertyValues([
        { source: true, properties: nativeProperties },
        { source: colors, properties: colorProperties }
      ]),
      text: {
        ...mapValues(colors, (color) => ({ color })),
        ...mapValues(values("fontSizes"), ({ size, lineHeight }) => ({
          fontSize: size,
          lineHeight
        })),
        ...mapValues(
          {
            left: "left",
            center: "center",
            right: "right",
            justify: "justify",
            start: "start",
            end: "end"
          } as const,
          (textAlign) => ({ textAlign })
        )
      },
      font: {
        ...mapValues(values("fonts"), (fontFamily) => ({ fontFamily })),
        ...mapValues(values("fontWeights"), (fontWeight) => ({ fontWeight }))
      },
      fill: { ...colors, none: "none" },
      stroke: { ...colors, none: "none" },
      ...defineRules.propertyValues([
        { source: spacing(vars.spacing), properties: spacingProperties },
        {
          source: spacing(vars.spacing, true),
          properties: signedSpacingProperties
        },
        { source: radii, properties: radiusProperties },
        {
          source: widths,
          properties: [
            "width",
            "minWidth",
            "inlineSize",
            "minInlineSize",
            "flexBasis"
          ]
        },
        {
          source: sizing(
            vars.spacing,
            { ...values("containers"), ...values("maxWidths") },
            "w"
          ),
          properties: ["maxWidth", "maxInlineSize"]
        },
        {
          source: heights,
          properties: [
            "height",
            "minHeight",
            "maxHeight",
            "blockSize",
            "minBlockSize",
            "maxBlockSize"
          ]
        }
      ]),
      fontFamily: { ...globals, ...values("fonts") },
      fontSize: {
        ...globals,
        ...mapValues(values("fontSizes"), ({ size, lineHeight }) => ({
          fontSize: size,
          lineHeight
        }))
      },
      fontWeight: { ...globals, ...values("fontWeights") },
      letterSpacing: { ...globals, ...values("letterSpacings") },
      lineHeight(
        value: (keyof V["lineHeights"] & string) | number | (string & {})
      ) {
        if (
          typeof value === "string" &&
          Object.hasOwn(values("lineHeights"), value)
        )
          return values("lineHeights")[value];

        if (value === "none") return 1;

        return spacing(vars.spacing)(value as string | number);
      },
      boxShadow: { ...globals, ...values("shadows"), none: "none" },
      textShadow: { ...globals, ...values("textShadows"), none: "none" },
      perspective: { ...globals, none: "none", ...values("perspectives") },
      aspectRatio: {
        ...globals,
        square: "1 / 1",
        auto: "auto",
        ...values("aspectRatios")
      },
      transitionTimingFunction: {
        ...globals,
        linear: "linear",
        ...values("easings"),
        DEFAULT: vars.defaults.transitionTimingFunction
      },
      animation: { ...globals, none: "none", ...values("animations") },
      blur: mapValues(values("blurs"), (value) => ({
        filter: `blur(${value})`
      })),
      backdropBlur: mapValues(values("blurs"), (value) => ({
        backdropFilter: `blur(${value})`
      })),
      dropShadow: mapValues(values("dropShadows"), (values) => ({
        filter: values.map((value) => `drop-shadow(${value})`).join(" ")
      })),
      insetShadow: mapValues(values("insetShadows"), (value) => ({
        boxShadow: value
      })),
      lineClamp
    },
    shortcuts: {
      ...utilityStyles,
      container,
      bg: "backgroundColor",
      p: ["px", "py"],
      px: ["paddingLeft", "paddingRight"],
      py: ["paddingTop", "paddingBottom"],
      pt: "paddingTop",
      pr: "paddingRight",
      pb: "paddingBottom",
      pl: "paddingLeft",
      ps: "paddingInlineStart",
      pe: "paddingInlineEnd",
      m: ["mx", "my"],
      mx: ["marginLeft", "marginRight"],
      my: ["marginTop", "marginBottom"],
      mt: "marginTop",
      mr: "marginRight",
      mb: "marginBottom",
      ml: "marginLeft",
      ms: "marginInlineStart",
      me: "marginInlineEnd",
      w: "width",
      h: "height",
      size: ["width", "height"],
      rounded(value?: keyof typeof radii | boolean) {
        return value === false
          ? {}
          : {
              borderRadius:
                value === undefined || value === true ? "DEFAULT" : value
            };
      },
      shadow: "boxShadow",
      animate: "animation",
      leading: "lineHeight",
      tracking: "letterSpacing",
      gapX: "columnGap",
      gapY: "rowGap"
    } as const
  };
}

export type ThemeSpec<
  V extends TailwindScales,
  B extends Breakpoints
> = ReturnType<typeof createSpec<V, B>>;
