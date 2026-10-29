/** Shared by React rendering and Babel lowering; keep this module free of DOM and compiler imports. */
export const layoutStaticAttribute = "data-mincho-layout-static";
export const layoutPropKeys: ReadonlySet<string> = new Set([
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "padding",
  "overflow",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "direction",
  "shrink",
  "alignSelf",
  "axis",
  "gap",
  "justify",
  "align",
  "wrap",
  "lineGap",
  "alignLines",
  "gapBefore",
  "gapAfter",
  "breakBefore",
  "breakAfter"
]);
export const layoutOwnedStyle =
  /^(?:all|width|height|minWidth|maxWidth|minHeight|maxHeight|(?:min|max)?(?:Inline|Block)Size|inlineSize|blockSize|(?:min|max)?[Ll]ogical(?:Width|Height)|padding.*|margin.*|inset.*|top|right|bottom|left|position|direction|writingMode|boxSizing|overflow(?:X|Y|Inline|Block)?|flex.*|gap|rowGap|columnGap|align.*|justify.*|place(?:Self|Items|Content)|order|float|display|--mincho-layout-.*)$/;

/** Vendor aliases can override the same longhands as standard React style keys. */
export function isLayoutOwnedStyle(property: string): boolean {
  const canonical = property.replace(
    /^(?:Webkit|Moz|ms|O)([A-Z])/,
    (_prefix, initial: string) => initial.toLowerCase()
  );
  return layoutOwnedStyle.test(canonical);
}
