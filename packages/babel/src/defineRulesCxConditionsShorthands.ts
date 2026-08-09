import { isSupportedCssDeclarationProperty } from "./cssProperty.js";

const shorthandLonghands = {
  all: [],
  animation: [
    "animationComposition",
    "animationDelay",
    "animationDirection",
    "animationDuration",
    "animationFillMode",
    "animationIterationCount",
    "animationName",
    "animationPlayState",
    "animationRangeEnd",
    "animationRangeStart",
    "animationTimeline",
    "animationTimingFunction"
  ],
  background: [
    "backgroundAttachment",
    "backgroundBlendMode",
    "backgroundClip",
    "backgroundColor",
    "backgroundImage",
    "backgroundOrigin",
    "backgroundPosition",
    "backgroundRepeat",
    "backgroundSize"
  ],
  border: [
    "borderBottom",
    "borderBottomColor",
    "borderBottomStyle",
    "borderBottomWidth",
    "borderColor",
    "borderLeft",
    "borderLeftColor",
    "borderLeftStyle",
    "borderLeftWidth",
    "borderRight",
    "borderRightColor",
    "borderRightStyle",
    "borderRightWidth",
    "borderStyle",
    "borderTop",
    "borderTopColor",
    "borderTopStyle",
    "borderTopWidth",
    "borderWidth"
  ],
  borderBlock: [
    "borderBlockColor",
    "borderBlockEnd",
    "borderBlockStart",
    "borderBlockStyle",
    "borderBlockWidth"
  ],
  borderInline: [
    "borderInlineColor",
    "borderInlineEnd",
    "borderInlineStart",
    "borderInlineStyle",
    "borderInlineWidth"
  ],
  borderRadius: [
    "borderBottomLeftRadius",
    "borderBottomRightRadius",
    "borderEndEndRadius",
    "borderEndStartRadius",
    "borderStartEndRadius",
    "borderStartStartRadius",
    "borderTopLeftRadius",
    "borderTopRightRadius"
  ],
  columns: ["columnCount", "columnWidth"],
  columnRule: ["columnRuleColor", "columnRuleStyle", "columnRuleWidth"],
  flex: ["flexBasis", "flexGrow", "flexShrink"],
  flexFlow: ["flexDirection", "flexWrap"],
  font: [
    "fontFamily",
    "fontSize",
    "fontStretch",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "lineHeight"
  ],
  gap: ["columnGap", "rowGap"],
  grid: [
    "gridAutoColumns",
    "gridAutoFlow",
    "gridAutoRows",
    "gridTemplateAreas",
    "gridTemplateColumns",
    "gridTemplateRows"
  ],
  gridArea: ["gridColumnEnd", "gridColumnStart", "gridRowEnd", "gridRowStart"],
  gridColumn: ["gridColumnEnd", "gridColumnStart"],
  gridRow: ["gridRowEnd", "gridRowStart"],
  gridTemplate: [
    "gridTemplateAreas",
    "gridTemplateColumns",
    "gridTemplateRows"
  ],
  inset: ["bottom", "insetBlock", "insetInline", "left", "right", "top"],
  insetBlock: ["insetBlockEnd", "insetBlockStart"],
  insetInline: ["insetInlineEnd", "insetInlineStart"],
  listStyle: ["listStyleImage", "listStylePosition", "listStyleType"],
  margin: ["marginBottom", "marginLeft", "marginRight", "marginTop"],
  marginBlock: ["marginBlockEnd", "marginBlockStart"],
  marginInline: ["marginInlineEnd", "marginInlineStart"],
  outline: ["outlineColor", "outlineStyle", "outlineWidth"],
  overflow: ["overflowX", "overflowY"],
  overscrollBehavior: ["overscrollBehaviorX", "overscrollBehaviorY"],
  padding: ["paddingBottom", "paddingLeft", "paddingRight", "paddingTop"],
  paddingBlock: ["paddingBlockEnd", "paddingBlockStart"],
  paddingInline: ["paddingInlineEnd", "paddingInlineStart"],
  placeContent: ["alignContent", "justifyContent"],
  placeItems: ["alignItems", "justifyItems"],
  placeSelf: ["alignSelf", "justifySelf"],
  scrollMargin: [
    "scrollMarginBottom",
    "scrollMarginLeft",
    "scrollMarginRight",
    "scrollMarginTop"
  ],
  scrollPadding: [
    "scrollPaddingBottom",
    "scrollPaddingLeft",
    "scrollPaddingRight",
    "scrollPaddingTop"
  ],
  textDecoration: [
    "textDecorationColor",
    "textDecorationLine",
    "textDecorationStyle",
    "textDecorationThickness"
  ],
  textEmphasis: ["textEmphasisColor", "textEmphasisStyle"],
  transition: [
    "transitionBehavior",
    "transitionDelay",
    "transitionDuration",
    "transitionProperty",
    "transitionTimingFunction"
  ]
} as const satisfies Readonly<Record<string, readonly string[]>>;

export function mayHaveShorthandConflict(left: string, right: string): boolean {
  if (
    left === right ||
    !isSupportedCssDeclarationProperty(left) ||
    !isSupportedCssDeclarationProperty(right)
  ) {
    return false;
  }

  return (
    left === "all" ||
    right === "all" ||
    isShorthandFor(left, right) ||
    isShorthandFor(right, left)
  );
}

function isShorthandFor(shorthand: string, longhand: string): boolean {
  return Object.entries(shorthandLonghands).some(
    ([candidate, longhands]) =>
      candidate === shorthand &&
      longhands.some(
        (property) =>
          property === longhand || isShorthandFor(property, longhand)
      )
  );
}
