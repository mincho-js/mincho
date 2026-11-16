import type { CSSProperties } from "@mincho-js/css";

/** Theme UI v0.17.4's scale associations, including logical properties. */
export const scaleProperties = {
  colors: [
    "color",
    "background",
    "accentColor",
    "backgroundColor",
    "borderColor",
    "caretColor",
    "columnRuleColor",
    "outlineColor",
    "textDecorationColor",
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
    "borderBlockColor",
    "borderBlockEndColor",
    "borderBlockStartColor",
    "borderInlineColor",
    "borderInlineEndColor",
    "borderInlineStartColor",
    "fill",
    "stroke"
  ],
  space: [
    "margin",
    "marginTop",
    "marginRight",
    "marginBottom",
    "marginLeft",
    "marginBlock",
    "marginBlockEnd",
    "marginBlockStart",
    "marginInline",
    "marginInlineEnd",
    "marginInlineStart",
    "padding",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "paddingBlock",
    "paddingBlockEnd",
    "paddingBlockStart",
    "paddingInline",
    "paddingInlineEnd",
    "paddingInlineStart",
    "scrollMargin",
    "scrollMarginTop",
    "scrollMarginRight",
    "scrollMarginBottom",
    "scrollMarginLeft",
    "scrollPadding",
    "scrollPaddingTop",
    "scrollPaddingRight",
    "scrollPaddingBottom",
    "scrollPaddingLeft",
    "inset",
    "insetBlock",
    "insetBlockEnd",
    "insetBlockStart",
    "insetInline",
    "insetInlineEnd",
    "insetInlineStart",
    "top",
    "right",
    "bottom",
    "left",
    "gridGap",
    "gridColumnGap",
    "gridRowGap",
    "gap",
    "columnGap",
    "rowGap"
  ],
  fonts: ["fontFamily"],
  fontSizes: ["fontSize"],
  fontWeights: ["fontWeight"],
  lineHeights: ["lineHeight"],
  letterSpacings: ["letterSpacing"],
  opacities: ["opacity"],
  transitions: ["transition"],
  borders: [
    "border",
    "borderTop",
    "borderRight",
    "borderBottom",
    "borderLeft",
    "borderBlock",
    "borderBlockEnd",
    "borderBlockStart",
    "borderInline",
    "borderInlineEnd",
    "borderInlineStart"
  ],
  borderWidths: [
    "borderWidth",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "borderBlockWidth",
    "borderBlockEndWidth",
    "borderBlockStartWidth",
    "borderInlineWidth",
    "borderInlineEndWidth",
    "borderInlineStartWidth",
    "columnRuleWidth"
  ],
  borderStyles: [
    "borderStyle",
    "borderTopStyle",
    "borderRightStyle",
    "borderBottomStyle",
    "borderLeftStyle",
    "borderBlockStyle",
    "borderBlockEndStyle",
    "borderBlockStartStyle",
    "borderInlineStyle",
    "borderInlineEndStyle",
    "borderInlineStartStyle"
  ],
  radii: [
    "borderRadius",
    "borderTopLeftRadius",
    "borderTopRightRadius",
    "borderBottomLeftRadius",
    "borderBottomRightRadius",
    "borderEndEndRadius",
    "borderEndStartRadius",
    "borderStartEndRadius",
    "borderStartStartRadius"
  ],
  shadows: ["boxShadow", "textShadow"],
  sizes: [
    "width",
    "minWidth",
    "maxWidth",
    "height",
    "minHeight",
    "maxHeight",
    "flexBasis",
    "blockSize",
    "inlineSize",
    "maxBlockSize",
    "maxInlineSize",
    "minBlockSize",
    "minInlineSize",
    "columnWidth"
  ],
  zIndices: ["zIndex"]
} as const satisfies Record<string, readonly (keyof CSSProperties)[]>;

export type ScaleName = keyof typeof scaleProperties;

export const shortcuts = {
  bg: "backgroundColor",
  m: ["mx", "my"],
  mt: "marginTop",
  mr: "marginRight",
  mb: "marginBottom",
  ml: "marginLeft",
  mx: ["marginLeft", "marginRight"],
  my: ["marginTop", "marginBottom"],
  p: ["px", "py"],
  pt: "paddingTop",
  pr: "paddingRight",
  pb: "paddingBottom",
  pl: "paddingLeft",
  px: ["paddingLeft", "paddingRight"],
  py: ["paddingTop", "paddingBottom"],
  marginX: ["marginLeft", "marginRight"],
  marginY: ["marginTop", "marginBottom"],
  paddingX: ["paddingLeft", "paddingRight"],
  paddingY: ["paddingTop", "paddingBottom"],
  scrollMarginX: ["scrollMarginLeft", "scrollMarginRight"],
  scrollMarginY: ["scrollMarginTop", "scrollMarginBottom"],
  scrollPaddingX: ["scrollPaddingLeft", "scrollPaddingRight"],
  scrollPaddingY: ["scrollPaddingTop", "scrollPaddingBottom"],
  size: ["width", "height"]
} as const;

export const defaultBreakpoints = [
  "40em",
  "52em",
  "64em"
] as const satisfies string[];

/** Preserve the named Mincho conditions while accepting Theme UI breakpoint arrays. */
export function breakpointEntries(
  breakpoints: readonly string[] | Readonly<Record<string, string>>
) {
  return Array.isArray(breakpoints)
    ? breakpoints.flatMap((value, index) =>
        value === undefined
          ? []
          : [[["sm", "md", "lg"][index] ?? `bp${index + 1}`, value] as const]
      )
    : Object.entries(breakpoints).filter(([, value]) => value !== undefined);
}

export function breakpointQuery(value: string): string {
  const query = value.trim();

  if (!query) throw new Error("Empty Theme UI breakpoint");

  if (/\bvar\(/i.test(query)) {
    throw new TypeError(
      "Theme UI breakpoints cannot use CSS variables in media queries"
    );
  }

  if (/^@media\s/i.test(query)) return query.replace(/^@media\s+/i, "");

  const isLength = /^(?:[+-]?(?:\d|\.\d)|(?:calc|min|max|clamp|env)\()/i.test(
    query
  );

  return isLength ? `screen and (min-width: ${query})` : query;
}
