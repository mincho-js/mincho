// https://stackoverflow.com/questions/42999983/typescript-removing-readonly-modifier
type DeepWriteable<T> = { -readonly [P in keyof T]: DeepWriteable<T[P]> };

export type CamelPseudos =
  | "_MozAnyLink"
  | "_MozFullScreen"
  | "_MozPlaceholder"
  | "_MozReadOnly"
  | "_MozReadWrite"
  | "_MsFullscreen"
  | "_MsInputPlaceholder"
  | "_WebkitAnyLink"
  | "_WebkitFullScreen"
  | "__MozPlaceholder"
  | "__MozProgressBar"
  | "__MozRangeProgress"
  | "__MozRangeThumb"
  | "__MozRangeTrack"
  | "__MozSelection"
  | "__MsBackdrop"
  | "__MsBrowse"
  | "__MsCheck"
  | "__MsClear"
  | "__MsFill"
  | "__MsFillLower"
  | "__MsFillUpper"
  | "__MsReveal"
  | "__MsThumb"
  | "__MsTicksAfter"
  | "__MsTicksBefore"
  | "__MsTooltip"
  | "__MsTrack"
  | "__MsValue"
  | "__WebkitBackdrop"
  | "__WebkitInputPlaceholder"
  | "__WebkitProgressBar"
  | "__WebkitProgressInnerValue"
  | "__WebkitProgressValue"
  | "__WebkitResizer"
  | "__WebkitScrollbarButton"
  | "__WebkitScrollbarCorner"
  | "__WebkitScrollbarThumb"
  | "__WebkitScrollbarTrackPiece"
  | "__WebkitScrollbarTrack"
  | "__WebkitScrollbar"
  | "__WebkitSliderRunnableTrack"
  | "__WebkitSliderThumb"
  | "__after"
  | "__backdrop"
  | "__before"
  | "__cue"
  | "__firstLetter"
  | "__firstLine"
  | "__grammarError"
  | "__placeholder"
  | "__selection"
  | "__spellingError"
  | "_active"
  | "_after"
  | "_anyLink"
  | "_before"
  | "_blank"
  | "_checked"
  | "_default"
  | "_defined"
  | "_disabled"
  | "_empty"
  | "_enabled"
  | "_first"
  | "_firstChild"
  | "_firstLetter"
  | "_firstLine"
  | "_firstOfType"
  | "_focus"
  | "_focusVisible"
  | "_focusWithin"
  | "_fullscreen"
  | "_hover"
  | "_inRange"
  | "_indeterminate"
  | "_invalid"
  | "_lastChild"
  | "_lastOfType"
  | "_left"
  | "_link"
  | "_onlyChild"
  | "_onlyOfType"
  | "_optional"
  | "_outOfRange"
  | "_placeholderShown"
  | "_readOnly"
  | "_readWrite"
  | "_required"
  | "_right"
  | "_root"
  | "_scope"
  | "_target"
  | "_valid"
  | "_visited";

export type SpacePropertiesKey =
  | "msContentZoomSnap"
  | "MozBorderBottomColors"
  | "MozBorderLeftColors"
  | "MozBorderRightColors"
  | "MozBorderTopColors"
  | "MozOutlineRadius"
  | "WebkitAppearance"
  | "WebkitBorderBefore"
  | "WebkitBoxReflect"
  | "WebkitTextStroke"
  | "alignContent"
  | "alignItems"
  | "alignSelf"
  | "aspectRatio"
  | "azimuth"
  | "backdropFilter"
  | "border"
  | "borderBlock"
  | "borderBlockEnd"
  | "borderBlockStart"
  | "borderBottom"
  | "borderImage"
  | "borderImageSlice"
  | "borderInline"
  | "borderInlineEnd"
  | "borderInlineStart"
  | "borderLeft"
  | "borderRadius"
  | "borderRight"
  | "borderSpacing"
  | "borderTop"
  | "colorScheme"
  | "columnRule"
  | "columns"
  | "contain"
  | "containIntrinsicSize"
  | "containIntrinsicBlockSize"
  | "containIntrinsicHeight"
  | "containIntrinsicInlineSize"
  | "containIntrinsicWidth"
  | "container"
  | "containerName"
  | "content"
  | "counterIncrement"
  | "counterReset"
  | "counterSet"
  | "display"
  | "filter"
  | "flex"
  | "flexFlow"
  | "font"
  | "fontSizeAdjust"
  | "fontStyle"
  | "fontSynthesis"
  | "fontVariantEastAsian"
  | "fontVariantLigatures"
  | "fontVariantNumeric"
  | "gap"
  | "grid"
  | "gridArea"
  | "gridAutoFlow"
  | "gridColumn"
  | "gridColumnEnd"
  | "gridColumnStart"
  | "gridGap"
  | "gridRow"
  | "gridRowEnd"
  | "gridRowStart"
  | "gridTemplateAreas"
  | "hangingPunctuation"
  | "imageOrientation"
  | "imageResolution"
  | "initialLetter"
  | "justifyContent"
  | "justifyItems"
  | "justifySelf"
  | "listStyle"
  | "maskBorder"
  | "maskBorderSlice"
  | "masonryAutoFlow"
  | "objectPosition"
  | "offset"
  | "offsetAnchor"
  | "offsetPath"
  | "offsetPosition"
  | "offsetRotate"
  | "outline"
  | "overflowClipMargin"
  | "paintOrder"
  | "perspectiveOrigin"
  | "placeContent"
  | "placeItems"
  | "placeSelf"
  | "quotes"
  | "rotate"
  | "rubyPosition"
  | "scrollbarGutter"
  | "scrollSnapDestination"
  | "scrollSnapType"
  | "textCombineUpright"
  | "textDecoration"
  | "textDecorationLine"
  | "textDecorationSkip"
  | "textEmphasis"
  | "textEmphasisPosition"
  | "textEmphasisStyle"
  | "textIndent"
  | "textUnderlinePosition"
  | "touchAction"
  | "transform"
  | "transformOrigin"
  | "translate"
  | "whiteSpace"
  | "whiteSpaceTrim";
export type CommaPropertiesKey =
  | "msContentZoomSnapPoints"
  | "msFlowFrom"
  | "msFlowInto"
  | "msGridColumns"
  | "msGridRows"
  | "msScrollSnapPointsX"
  | "msScrollSnapPointsY"
  | "MozContextProperties"
  | "MozImageRegion"
  | "WebkitMask"
  | "WebkitMaskAttachment"
  | "WebkitMaskClip"
  | "WebkitMaskComposite"
  | "WebkitMaskImage"
  | "WebkitMaskOrigin"
  | "WebkitMaskPosition"
  | "WebkitMaskPositionX"
  | "WebkitMaskPositionY"
  | "WebkitMaskRepeat"
  | "WebkitMaskSize"
  | "alignTracks"
  | "animation"
  | "animationComposition"
  | "animationDelay"
  | "animationDirection"
  | "animationDuration"
  | "animationFillMode"
  | "animationIterationCount"
  | "animationName"
  | "animationPlayState"
  | "animationRange"
  | "animationRangeEnd"
  | "animationRangeStart"
  | "animationTimingFunction"
  | "animationTimeline"
  | "background"
  | "backgroundAttachment"
  | "backgroundBlendMode"
  | "backgroundClip"
  | "backgroundImage"
  | "backgroundOrigin"
  | "backgroundPosition"
  | "backgroundPositionX"
  | "backgroundPositionY"
  | "backgroundRepeat"
  | "backgroundSize"
  | "boxShadow"
  | "caret"
  | "clip"
  | "clipPath"
  | "cursor"
  | "fontFamily"
  | "fontFeatureSettings"
  | "fontVariationSettings"
  | "fontVariant"
  | "fontVariantAlternates"
  | "gridAutoColumns"
  | "gridAutoRows"
  | "gridTemplate"
  | "gridTemplateColumns"
  | "gridTemplateRows"
  | "justifyTracks"
  | "mask"
  | "maskClip"
  | "maskComposite"
  | "maskImage"
  | "maskMode"
  | "maskOrigin"
  | "maskPosition"
  | "maskRepeat"
  | "maskSize"
  | "scrollSnapCoordinate"
  | "scrollTimeline"
  | "scrollTimelineAxis"
  | "scrollTimelineName"
  | "shapeOutside"
  | "textShadow"
  | "timelineScope"
  | "transition"
  | "transitionBehavior"
  | "transitionDelay"
  | "transitionDuration"
  | "transitionProperty"
  | "transitionTimingFunction"
  | "viewTimeline"
  | "viewTimelineAxis"
  | "viewTimelineInset"
  | "viewTimelineName"
  | "willChange";

export const shorthandProperties = {
  msContentZoomLimit: ["msContentZoomLimitMax", "msContentZoomLimitMin"],
  msContentZoomSnap: ["msContentZoomSnapType", "msContentZoomSnapPoints"],
  msScrollLimit: [
    "msScrollLimitXMin",
    "msScrollLimitYMin",
    "msScrollLimitXMax",
    "msScrollLimitYMax"
  ],
  msScrollSnapX: ["msScrollSnapType", "msScrollSnapPointsX"],
  msScrollSnapY: ["msScrollSnapType", "msScrollSnapPointsY"],
  MozOutlineRadius: [
    "MozOutlineRadiusTopleft",
    "MozOutlineRadiusTopright",
    "MozOutlineRadiusBottomright",
    "MozOutlineRadiusBottomleft"
  ],
  WebkitBorderBefore: ["borderWidth", "borderStyle", "color"],
  WebkitMask: [
    "WebkitMaskImage",
    "WebkitMaskRepeat",
    "WebkitMaskAttachment",
    "WebkitMaskPosition",
    "WebkitMaskOrigin",
    "WebkitMaskClip"
  ],
  WebkitTextStroke: ["WebkitTextStrokeWidth", "WebkitTextStrokeColor"],
  animation: [
    "animationName",
    "animationDuration",
    "animationTimingFunction",
    "animationDelay",
    "animationIterationCount",
    "animationDirection",
    "animationFillMode",
    "animationPlayState",
    "animationTimeline"
  ],
  animationRange: ["animationRangeStart", "animationRangeEnd"],
  background: [
    "backgroundImage",
    "backgroundPosition",
    "backgroundSize",
    "backgroundRepeat",
    "backgroundOrigin",
    "backgroundClip",
    "backgroundAttachment",
    "backgroundColor"
  ],
  border: ["borderWidth", "borderStyle", "borderColor"],
  borderBlock: ["borderBlockWidth", "borderBlockStyle", "borderBlockColor"],
  borderBlockEnd: ["borderTopWidth", "borderTopStyle", "borderTopColor"],
  borderBlockStart: ["borderWidth", "borderStyle", "color"],
  borderBottom: ["borderBottomWidth", "borderBottomStyle", "borderBottomColor"],
  borderColor: [
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor"
  ],
  borderImage: [
    "borderImageSource",
    "borderImageSlice",
    "borderImageWidth",
    "borderImageOutset",
    "borderImageRepeat"
  ],
  borderInline: ["borderInlineWidth", "borderInlineStyle", "borderInlineColor"],
  borderInlineEnd: ["borderWidth", "borderStyle", "color"],
  borderInlineStart: ["borderWidth", "borderStyle", "color"],
  borderLeft: ["borderLeftWidth", "borderLeftStyle", "borderLeftColor"],
  borderRadius: [
    "borderTopLeftRadius",
    "borderTopRightRadius",
    "borderBottomRightRadius",
    "borderBottomLeftRadius"
  ],
  borderRight: ["borderRightWidth", "borderRightStyle", "borderRightColor"],
  borderStyle: [
    "borderTopStyle",
    "borderRightStyle",
    "borderBottomStyle",
    "borderLeftStyle"
  ],
  borderTop: ["borderTopWidth", "borderTopStyle", "borderTopColor"],
  borderWidth: [
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth"
  ],
  caret: ["caretColor", "caretShape"],
  columnRule: ["columnRuleWidth", "columnRuleStyle", "columnRuleColor"],
  columns: ["columnWidth", "columnCount"],
  containIntrinsicSize: ["containIntrinsicWidth", "containIntrinsicHeight"],
  container: ["containerName", "containerType"],
  flex: ["flexGrow", "flexShrink", "flexBasis"],
  flexFlow: ["flexDirection", "flexWrap"],
  font: [
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "fontStretch",
    "fontSize",
    "lineHeight",
    "fontFamily"
  ],
  gap: ["rowGap", "columnGap"],
  grid: [
    "gridTemplateRows",
    "gridTemplateColumns",
    "gridTemplateAreas",
    "gridAutoRows",
    "gridAutoColumns",
    "gridAutoFlow",
    "gridColumnGap",
    "gridRowGap",
    "columnGap",
    "rowGap"
  ],
  gridArea: ["gridRowStart", "gridColumnStart", "gridRowEnd", "gridColumnEnd"],
  gridColumn: ["gridColumnStart", "gridColumnEnd"],
  gridGap: ["gridRowGap", "gridColumnGap"],
  gridRow: ["gridRowStart", "gridRowEnd"],
  gridTemplate: [
    "gridTemplateColumns",
    "gridTemplateRows",
    "gridTemplateAreas"
  ],
  inset: ["top", "bottom", "left", "right"],
  insetBlock: ["insetBlockStart", "insetBlockEnd"],
  insetInline: ["insetInlineStart", "insetInlineEnd"],
  listStyle: ["listStyleType", "listStylePosition", "listStyleImage"],
  margin: ["marginBottom", "marginLeft", "marginRight", "marginTop"],
  marginBlock: ["marginBlockStart", "marginBlockEnd"],
  marginInline: ["marginInlineStart", "marginInlineEnd"],
  mask: [
    "maskImage",
    "maskMode",
    "maskRepeat",
    "maskPosition",
    "maskClip",
    "maskOrigin",
    "maskSize",
    "maskComposite"
  ],
  maskBorder: [
    "maskBorderMode",
    "maskBorderOutset",
    "maskBorderRepeat",
    "maskBorderSlice",
    "maskBorderSource",
    "maskBorderWidth"
  ],
  offset: [
    "offsetPosition",
    "offsetPath",
    "offsetDistance",
    "offsetAnchor",
    "offsetRotate"
  ],
  outline: ["outlineColor", "outlineStyle", "outlineWidth"],
  padding: ["paddingBottom", "paddingLeft", "paddingRight", "paddingTop"],
  paddingBlock: ["paddingBlockStart", "paddingBlockEnd"],
  paddingInline: ["paddingInlineStart", "paddingInlineEnd"],
  placeContent: ["alignContent", "justifyContent"],
  placeItems: ["alignItems", "justifyItems"],
  placeSelf: ["alignSelf", "justifySelf"],
  scrollMargin: [
    "scrollMarginBottom",
    "scrollMarginLeft",
    "scrollMarginRight",
    "scrollMarginTop"
  ],
  scrollMarginBlock: ["scrollMarginBlockStart", "scrollMarginBlockEnd"],
  scrollMarginInline: ["scrollMarginInlineStart", "scrollMarginInlineEnd"],
  scrollPadding: [
    "scrollPaddingBottom",
    "scrollPaddingLeft",
    "scrollPaddingRight",
    "scrollPaddingTop"
  ],
  scrollPaddingBlock: ["scrollPaddingBlockStart", "scrollPaddingBlockEnd"],
  scrollPaddingInline: ["scrollPaddingInlineStart", "scrollPaddingInlineEnd"],
  scrollTimeline: ["scrollTimelineName", "scrollTimelineAxis"],
  textDecoration: [
    "textDecorationColor",
    "textDecorationStyle",
    "textDecorationLine"
  ],
  textEmphasis: ["textEmphasisStyle", "textEmphasisColor"],
  transition: [
    "transitionDelay",
    "transitionDuration",
    "transitionProperty",
    "transitionTimingFunction",
    "transitionBehavior"
  ],
  viewTimeline: ["viewTimelineName", "viewTimelineAxis"]
} as const;
export type ShorthandProperties = DeepWriteable<typeof shorthandProperties>;

export const nestedPropertiesMap: NestedPropertiesMap = {
  msContentZoomLimit: {
    Max: "msContentZoomLimitMax",
    Min: "msContentZoomLimitMin"
  },
  msContentZoomSnap: {
    Points: "msContentZoomSnapPoints",
    Type: "msContentZoomSnapType"
  },
  msScrollLimit: {
    XMax: "msScrollLimitXMax",
    XMin: "msScrollLimitXMin",
    YMax: "msScrollLimitYMax",
    YMin: "msScrollLimitYMin"
  },
  MozOutlineRadius: {
    Bottomleft: "MozOutlineRadiusBottomleft",
    Bottomright: "MozOutlineRadiusBottomright",
    Topleft: "MozOutlineRadiusTopleft",
    Topright: "MozOutlineRadiusTopright"
  },
  WebkitBorderBefore: {
    Color: "WebkitBorderBeforeColor",
    Style: "WebkitBorderBeforeStyle",
    Width: "WebkitBorderBeforeWidth"
  },
  WebkitMask: {
    Attachment: "WebkitMaskAttachment",
    Clip: "WebkitMaskClip",
    Composite: "WebkitMaskComposite",
    Image: "WebkitMaskImage",
    Origin: "WebkitMaskOrigin",
    Position: "WebkitMaskPosition",
    PositionX: "WebkitMaskPositionX",
    PositionY: "WebkitMaskPositionY",
    Repeat: "WebkitMaskRepeat",
    RepeatX: "WebkitMaskRepeatX",
    RepeatY: "WebkitMaskRepeatY",
    Size: "WebkitMaskSize"
  },
  WebkitMaskPosition: {
    X: "WebkitMaskPositionX",
    Y: "WebkitMaskPositionY"
  },
  WebkitMaskRepeat: {
    X: "WebkitMaskRepeatX",
    Y: "WebkitMaskRepeatY"
  },
  WebkitTextStroke: {
    Color: "WebkitTextStrokeColor",
    Width: "WebkitTextStrokeWidth"
  },
  animation: {
    Composition: "animationComposition",
    Delay: "animationDelay",
    Direction: "animationDirection",
    Duration: "animationDuration",
    FillMode: "animationFillMode",
    IterationCount: "animationIterationCount",
    Name: "animationName",
    PlayState: "animationPlayState",
    Range: "animationRange",
    RangeEnd: "animationRangeEnd",
    RangeStart: "animationRangeStart",
    TimingFunction: "animationTimingFunction",
    Timeline: "animationTimeline"
  },
  animationRange: {
    End: "animationRangeEnd",
    Start: "animationRangeStart"
  },
  background: {
    Attachment: "backgroundAttachment",
    BlendMode: "backgroundBlendMode",
    Clip: "backgroundClip",
    Color: "backgroundColor",
    Image: "backgroundImage",
    Origin: "backgroundOrigin",
    Position: "backgroundPosition",
    PositionX: "backgroundPositionX",
    PositionY: "backgroundPositionY",
    Repeat: "backgroundRepeat",
    Size: "backgroundSize"
  },
  backgroundPosition: {
    X: "backgroundPositionX",
    Y: "backgroundPositionY"
  },
  border: {
    Block: "borderBlock",
    BlockColor: "borderBlockColor",
    BlockStyle: "borderBlockStyle",
    BlockWidth: "borderBlockWidth",
    BlockEnd: "borderBlockEnd",
    BlockEndColor: "borderBlockEndColor",
    BlockEndStyle: "borderBlockEndStyle",
    BlockEndWidth: "borderBlockEndWidth",
    BlockStart: "borderBlockStart",
    BlockStartColor: "borderBlockStartColor",
    BlockStartStyle: "borderBlockStartStyle",
    BlockStartWidth: "borderBlockStartWidth",
    Bottom: "borderBottom",
    BottomColor: "borderBottomColor",
    BottomLeftRadius: "borderBottomLeftRadius",
    BottomRightRadius: "borderBottomRightRadius",
    BottomStyle: "borderBottomStyle",
    BottomWidth: "borderBottomWidth",
    Collapse: "borderCollapse",
    Color: "borderColor",
    EndEndRadius: "borderEndEndRadius",
    EndStartRadius: "borderEndStartRadius",
    Image: "borderImage",
    ImageOutset: "borderImageOutset",
    ImageRepeat: "borderImageRepeat",
    ImageSlice: "borderImageSlice",
    ImageSource: "borderImageSource",
    ImageWidth: "borderImageWidth",
    Inline: "borderInline",
    InlineEnd: "borderInlineEnd",
    InlineColor: "borderInlineColor",
    InlineStyle: "borderInlineStyle",
    InlineWidth: "borderInlineWidth",
    InlineEndColor: "borderInlineEndColor",
    InlineEndStyle: "borderInlineEndStyle",
    InlineEndWidth: "borderInlineEndWidth",
    InlineStart: "borderInlineStart",
    InlineStartColor: "borderInlineStartColor",
    InlineStartStyle: "borderInlineStartStyle",
    InlineStartWidth: "borderInlineStartWidth",
    Left: "borderLeft",
    LeftColor: "borderLeftColor",
    LeftStyle: "borderLeftStyle",
    LeftWidth: "borderLeftWidth",
    Radius: "borderRadius",
    Right: "borderRight",
    RightColor: "borderRightColor",
    RightStyle: "borderRightStyle",
    RightWidth: "borderRightWidth",
    Spacing: "borderSpacing",
    StartEndRadius: "borderStartEndRadius",
    StartStartRadius: "borderStartStartRadius",
    Style: "borderStyle",
    Top: "borderTop",
    TopColor: "borderTopColor",
    TopLeftRadius: "borderTopLeftRadius",
    TopRightRadius: "borderTopRightRadius",
    TopStyle: "borderTopStyle",
    TopWidth: "borderTopWidth",
    Width: "borderWidth"
  },
  borderBlock: {
    Color: "borderBlockColor",
    Style: "borderBlockStyle",
    Width: "borderBlockWidth",
    End: "borderBlockEnd",
    EndColor: "borderBlockEndColor",
    EndStyle: "borderBlockEndStyle",
    EndWidth: "borderBlockEndWidth",
    Start: "borderBlockStart",
    StartColor: "borderBlockStartColor",
    StartStyle: "borderBlockStartStyle",
    StartWidth: "borderBlockStartWidth"
  },
  borderBlockEnd: {
    Color: "borderBlockEndColor",
    Style: "borderBlockEndStyle",
    Width: "borderBlockEndWidth"
  },
  borderBlockStart: {
    Color: "borderBlockStartColor",
    Style: "borderBlockStartStyle",
    Width: "borderBlockStartWidth"
  },
  borderBottom: {
    Color: "borderBottomColor",
    LeftRadius: "borderBottomLeftRadius",
    RightRadius: "borderBottomRightRadius",
    Style: "borderBottomStyle",
    Width: "borderBottomWidth"
  },
  borderImage: {
    Outset: "borderImageOutset",
    Repeat: "borderImageRepeat",
    Slice: "borderImageSlice",
    Source: "borderImageSource",
    Width: "borderImageWidth"
  },
  borderInline: {
    End: "borderInlineEnd",
    Color: "borderInlineColor",
    Style: "borderInlineStyle",
    Width: "borderInlineWidth",
    EndColor: "borderInlineEndColor",
    EndStyle: "borderInlineEndStyle",
    EndWidth: "borderInlineEndWidth",
    Start: "borderInlineStart",
    StartColor: "borderInlineStartColor",
    StartStyle: "borderInlineStartStyle",
    StartWidth: "borderInlineStartWidth"
  },
  borderInlineEnd: {
    Color: "borderInlineEndColor",
    Style: "borderInlineEndStyle",
    Width: "borderInlineEndWidth"
  },
  borderInlineStart: {
    Color: "borderInlineStartColor",
    Style: "borderInlineStartStyle",
    Width: "borderInlineStartWidth"
  },
  borderLeft: {
    Color: "borderLeftColor",
    Style: "borderLeftStyle",
    Width: "borderLeftWidth"
  },
  borderRight: {
    Color: "borderRightColor",
    Style: "borderRightStyle",
    Width: "borderRightWidth"
  },
  borderTop: {
    Color: "borderTopColor",
    LeftRadius: "borderTopLeftRadius",
    RightRadius: "borderTopRightRadius",
    Style: "borderTopStyle",
    Width: "borderTopWidth"
  },
  boxFlex: {
    Group: "boxFlexGroup"
  },
  caret: {
    Color: "caretColor",
    Shape: "caretShape"
  },
  clip: {
    Path: "clipPath"
  },
  color: {
    Scheme: "colorScheme"
  },
  columnRule: {
    Color: "columnRuleColor",
    Style: "columnRuleStyle",
    Width: "columnRuleWidth"
  },
  contain: {
    IntrinsicSize: "containIntrinsicSize",
    IntrinsicBlockSize: "containIntrinsicBlockSize",
    IntrinsicHeight: "containIntrinsicHeight",
    IntrinsicInlineSize: "containIntrinsicInlineSize",
    IntrinsicWidth: "containIntrinsicWidth"
  },
  container: {
    Name: "containerName",
    Type: "containerType"
  },
  content: {
    Visibility: "contentVisibility"
  },
  flex: {
    Basis: "flexBasis",
    Direction: "flexDirection",
    Flow: "flexFlow",
    Grow: "flexGrow",
    Shrink: "flexShrink",
    Wrap: "flexWrap"
  },
  font: {
    Family: "fontFamily",
    FeatureSettings: "fontFeatureSettings",
    Kerning: "fontKerning",
    LanguageOverride: "fontLanguageOverride",
    OpticalSizing: "fontOpticalSizing",
    Palette: "fontPalette",
    VariationSettings: "fontVariationSettings",
    Size: "fontSize",
    SizeAdjust: "fontSizeAdjust",
    Smooth: "fontSmooth",
    Stretch: "fontStretch",
    Style: "fontStyle",
    Synthesis: "fontSynthesis",
    SynthesisPosition: "fontSynthesisPosition",
    SynthesisSmallCaps: "fontSynthesisSmallCaps",
    SynthesisStyle: "fontSynthesisStyle",
    SynthesisWeight: "fontSynthesisWeight",
    Variant: "fontVariant",
    VariantAlternates: "fontVariantAlternates",
    VariantCaps: "fontVariantCaps",
    VariantEastAsian: "fontVariantEastAsian",
    VariantEmoji: "fontVariantEmoji",
    VariantLigatures: "fontVariantLigatures",
    VariantNumeric: "fontVariantNumeric",
    VariantPosition: "fontVariantPosition",
    Weight: "fontWeight"
  },
  fontSize: {
    Adjust: "fontSizeAdjust"
  },
  fontSynthesis: {
    Position: "fontSynthesisPosition",
    SmallCaps: "fontSynthesisSmallCaps",
    Style: "fontSynthesisStyle",
    Weight: "fontSynthesisWeight"
  },
  fontVariant: {
    Alternates: "fontVariantAlternates",
    Caps: "fontVariantCaps",
    EastAsian: "fontVariantEastAsian",
    Emoji: "fontVariantEmoji",
    Ligatures: "fontVariantLigatures",
    Numeric: "fontVariantNumeric",
    Position: "fontVariantPosition"
  },
  grid: {
    Area: "gridArea",
    AutoColumns: "gridAutoColumns",
    AutoFlow: "gridAutoFlow",
    AutoRows: "gridAutoRows",
    Column: "gridColumn",
    ColumnEnd: "gridColumnEnd",
    ColumnGap: "gridColumnGap",
    ColumnStart: "gridColumnStart",
    Gap: "gridGap",
    Row: "gridRow",
    RowEnd: "gridRowEnd",
    RowGap: "gridRowGap",
    RowStart: "gridRowStart",
    Template: "gridTemplate",
    TemplateAreas: "gridTemplateAreas",
    TemplateColumns: "gridTemplateColumns",
    TemplateRows: "gridTemplateRows"
  },
  gridColumn: {
    End: "gridColumnEnd",
    Gap: "gridColumnGap",
    Start: "gridColumnStart"
  },
  gridRow: {
    End: "gridRowEnd",
    Gap: "gridRowGap",
    Start: "gridRowStart"
  },
  gridTemplate: {
    Areas: "gridTemplateAreas",
    Columns: "gridTemplateColumns",
    Rows: "gridTemplateRows"
  },
  initialLetter: {
    Align: "initialLetterAlign"
  },
  inset: {
    Block: "insetBlock",
    BlockEnd: "insetBlockEnd",
    BlockStart: "insetBlockStart",
    Inline: "insetInline",
    InlineEnd: "insetInlineEnd",
    InlineStart: "insetInlineStart"
  },
  insetBlock: {
    End: "insetBlockEnd",
    Start: "insetBlockStart"
  },
  insetInline: {
    End: "insetInlineEnd",
    Start: "insetInlineStart"
  },
  lineHeight: {
    Step: "lineHeightStep"
  },
  listStyle: {
    Image: "listStyleImage",
    Position: "listStylePosition",
    Type: "listStyleType"
  },
  margin: {
    Block: "marginBlock",
    BlockEnd: "marginBlockEnd",
    BlockStart: "marginBlockStart",
    Bottom: "marginBottom",
    Inline: "marginInline",
    InlineEnd: "marginInlineEnd",
    InlineStart: "marginInlineStart",
    Left: "marginLeft",
    Right: "marginRight",
    Top: "marginTop",
    Trim: "marginTrim"
  },
  marginBlock: {
    End: "marginBlockEnd",
    Start: "marginBlockStart"
  },
  marginInline: {
    End: "marginInlineEnd",
    Start: "marginInlineStart"
  },
  mask: {
    Border: "maskBorder",
    BorderMode: "maskBorderMode",
    BorderOutset: "maskBorderOutset",
    BorderRepeat: "maskBorderRepeat",
    BorderSlice: "maskBorderSlice",
    BorderSource: "maskBorderSource",
    BorderWidth: "maskBorderWidth",
    Clip: "maskClip",
    Composite: "maskComposite",
    Image: "maskImage",
    Mode: "maskMode",
    Origin: "maskOrigin",
    Position: "maskPosition",
    Repeat: "maskRepeat",
    Size: "maskSize",
    Type: "maskType"
  },
  maskBorder: {
    Mode: "maskBorderMode",
    Outset: "maskBorderOutset",
    Repeat: "maskBorderRepeat",
    Slice: "maskBorderSlice",
    Source: "maskBorderSource",
    Width: "maskBorderWidth"
  },
  offset: {
    Anchor: "offsetAnchor",
    Distance: "offsetDistance",
    Path: "offsetPath",
    Position: "offsetPosition",
    Rotate: "offsetRotate"
  },
  outline: {
    Color: "outlineColor",
    Offset: "outlineOffset",
    Style: "outlineStyle",
    Width: "outlineWidth"
  },
  overflow: {
    Anchor: "overflowAnchor",
    Block: "overflowBlock",
    ClipBox: "overflowClipBox",
    ClipMargin: "overflowClipMargin",
    Inline: "overflowInline",
    Wrap: "overflowWrap",
    X: "overflowX",
    Y: "overflowY"
  },
  overscrollBehavior: {
    Block: "overscrollBehaviorBlock",
    Inline: "overscrollBehaviorInline",
    X: "overscrollBehaviorX",
    Y: "overscrollBehaviorY"
  },
  padding: {
    Block: "paddingBlock",
    BlockEnd: "paddingBlockEnd",
    BlockStart: "paddingBlockStart",
    Bottom: "paddingBottom",
    Inline: "paddingInline",
    InlineEnd: "paddingInlineEnd",
    InlineStart: "paddingInlineStart",
    Left: "paddingLeft",
    Right: "paddingRight",
    Top: "paddingTop"
  },
  paddingBlock: {
    End: "paddingBlockEnd",
    Start: "paddingBlockStart"
  },
  paddingInline: {
    End: "paddingInlineEnd",
    Start: "paddingInlineStart"
  },
  page: {
    BreakAfter: "pageBreakAfter",
    BreakBefore: "pageBreakBefore",
    BreakInside: "pageBreakInside"
  },
  perspective: {
    Origin: "perspectiveOrigin"
  },
  scrollMargin: {
    Block: "scrollMarginBlock",
    BlockStart: "scrollMarginBlockStart",
    BlockEnd: "scrollMarginBlockEnd",
    Bottom: "scrollMarginBottom",
    Inline: "scrollMarginInline",
    InlineStart: "scrollMarginInlineStart",
    InlineEnd: "scrollMarginInlineEnd",
    Left: "scrollMarginLeft",
    Right: "scrollMarginRight",
    Top: "scrollMarginTop"
  },
  scrollMarginBlock: {
    Start: "scrollMarginBlockStart",
    End: "scrollMarginBlockEnd"
  },
  scrollMarginInline: {
    Start: "scrollMarginInlineStart",
    End: "scrollMarginInlineEnd"
  },
  scrollPadding: {
    Block: "scrollPaddingBlock",
    BlockStart: "scrollPaddingBlockStart",
    BlockEnd: "scrollPaddingBlockEnd",
    Bottom: "scrollPaddingBottom",
    Inline: "scrollPaddingInline",
    InlineStart: "scrollPaddingInlineStart",
    InlineEnd: "scrollPaddingInlineEnd",
    Left: "scrollPaddingLeft",
    Right: "scrollPaddingRight",
    Top: "scrollPaddingTop"
  },
  scrollPaddingBlock: {
    Start: "scrollPaddingBlockStart",
    End: "scrollPaddingBlockEnd"
  },
  scrollPaddingInline: {
    Start: "scrollPaddingInlineStart",
    End: "scrollPaddingInlineEnd"
  },
  scrollSnapType: {
    X: "scrollSnapTypeX",
    Y: "scrollSnapTypeY"
  },
  scrollTimeline: {
    Axis: "scrollTimelineAxis",
    Name: "scrollTimelineName"
  },
  textAlign: {
    Last: "textAlignLast"
  },
  textDecoration: {
    Color: "textDecorationColor",
    Line: "textDecorationLine",
    Skip: "textDecorationSkip",
    SkipInk: "textDecorationSkipInk",
    Style: "textDecorationStyle",
    Thickness: "textDecorationThickness"
  },
  textDecorationSkip: {
    Ink: "textDecorationSkipInk"
  },
  textEmphasis: {
    Color: "textEmphasisColor",
    Position: "textEmphasisPosition",
    Style: "textEmphasisStyle"
  },
  transform: {
    Box: "transformBox",
    Origin: "transformOrigin",
    Style: "transformStyle"
  },
  transition: {
    Behavior: "transitionBehavior",
    Delay: "transitionDelay",
    Duration: "transitionDuration",
    Property: "transitionProperty",
    TimingFunction: "transitionTimingFunction"
  },
  viewTimeline: {
    Axis: "viewTimelineAxis",
    Inset: "viewTimelineInset",
    Name: "viewTimelineName"
  },
  whiteSpace: {
    Collapse: "whiteSpaceCollapse",
    Trim: "whiteSpaceTrim"
  }
};
export type NestedPropertiesMap = {
  msContentZoomLimit: {
    Max: "msContentZoomLimitMax";
    Min: "msContentZoomLimitMin";
  };
  msContentZoomSnap: {
    Points: "msContentZoomSnapPoints";
    Type: "msContentZoomSnapType";
  };
  msScrollLimit: {
    XMax: "msScrollLimitXMax";
    XMin: "msScrollLimitXMin";
    YMax: "msScrollLimitYMax";
    YMin: "msScrollLimitYMin";
  };
  MozOutlineRadius: {
    Bottomleft: "MozOutlineRadiusBottomleft";
    Bottomright: "MozOutlineRadiusBottomright";
    Topleft: "MozOutlineRadiusTopleft";
    Topright: "MozOutlineRadiusTopright";
  };
  WebkitBorderBefore: {
    Color: "WebkitBorderBeforeColor";
    Style: "WebkitBorderBeforeStyle";
    Width: "WebkitBorderBeforeWidth";
  };
  WebkitMask: {
    Attachment: "WebkitMaskAttachment";
    Clip: "WebkitMaskClip";
    Composite: "WebkitMaskComposite";
    Image: "WebkitMaskImage";
    Origin: "WebkitMaskOrigin";
    Position: "WebkitMaskPosition";
    PositionX: "WebkitMaskPositionX";
    PositionY: "WebkitMaskPositionY";
    Repeat: "WebkitMaskRepeat";
    RepeatX: "WebkitMaskRepeatX";
    RepeatY: "WebkitMaskRepeatY";
    Size: "WebkitMaskSize";
  };
  WebkitMaskPosition: {
    X: "WebkitMaskPositionX";
    Y: "WebkitMaskPositionY";
  };
  WebkitMaskRepeat: {
    X: "WebkitMaskRepeatX";
    Y: "WebkitMaskRepeatY";
  };
  WebkitTextStroke: {
    Color: "WebkitTextStrokeColor";
    Width: "WebkitTextStrokeWidth";
  };
  animation: {
    Composition: "animationComposition";
    Delay: "animationDelay";
    Direction: "animationDirection";
    Duration: "animationDuration";
    FillMode: "animationFillMode";
    IterationCount: "animationIterationCount";
    Name: "animationName";
    PlayState: "animationPlayState";
    Range: "animationRange";
    RangeEnd: "animationRangeEnd";
    RangeStart: "animationRangeStart";
    TimingFunction: "animationTimingFunction";
    Timeline: "animationTimeline";
  };
  animationRange: {
    End: "animationRangeEnd";
    Start: "animationRangeStart";
  };
  background: {
    Attachment: "backgroundAttachment";
    BlendMode: "backgroundBlendMode";
    Clip: "backgroundClip";
    Color: "backgroundColor";
    Image: "backgroundImage";
    Origin: "backgroundOrigin";
    Position: "backgroundPosition";
    PositionX: "backgroundPositionX";
    PositionY: "backgroundPositionY";
    Repeat: "backgroundRepeat";
    Size: "backgroundSize";
  };
  backgroundPosition: {
    X: "backgroundPositionX";
    Y: "backgroundPositionY";
  };
  border: {
    Block: "borderBlock";
    BlockColor: "borderBlockColor";
    BlockStyle: "borderBlockStyle";
    BlockWidth: "borderBlockWidth";
    BlockEnd: "borderBlockEnd";
    BlockEndColor: "borderBlockEndColor";
    BlockEndStyle: "borderBlockEndStyle";
    BlockEndWidth: "borderBlockEndWidth";
    BlockStart: "borderBlockStart";
    BlockStartColor: "borderBlockStartColor";
    BlockStartStyle: "borderBlockStartStyle";
    BlockStartWidth: "borderBlockStartWidth";
    Bottom: "borderBottom";
    BottomColor: "borderBottomColor";
    BottomLeftRadius: "borderBottomLeftRadius";
    BottomRightRadius: "borderBottomRightRadius";
    BottomStyle: "borderBottomStyle";
    BottomWidth: "borderBottomWidth";
    Collapse: "borderCollapse";
    Color: "borderColor";
    EndEndRadius: "borderEndEndRadius";
    EndStartRadius: "borderEndStartRadius";
    Image: "borderImage";
    ImageOutset: "borderImageOutset";
    ImageRepeat: "borderImageRepeat";
    ImageSlice: "borderImageSlice";
    ImageSource: "borderImageSource";
    ImageWidth: "borderImageWidth";
    Inline: "borderInline";
    InlineEnd: "borderInlineEnd";
    InlineColor: "borderInlineColor";
    InlineStyle: "borderInlineStyle";
    InlineWidth: "borderInlineWidth";
    InlineEndColor: "borderInlineEndColor";
    InlineEndStyle: "borderInlineEndStyle";
    InlineEndWidth: "borderInlineEndWidth";
    InlineStart: "borderInlineStart";
    InlineStartColor: "borderInlineStartColor";
    InlineStartStyle: "borderInlineStartStyle";
    InlineStartWidth: "borderInlineStartWidth";
    Left: "borderLeft";
    LeftColor: "borderLeftColor";
    LeftStyle: "borderLeftStyle";
    LeftWidth: "borderLeftWidth";
    Radius: "borderRadius";
    Right: "borderRight";
    RightColor: "borderRightColor";
    RightStyle: "borderRightStyle";
    RightWidth: "borderRightWidth";
    Spacing: "borderSpacing";
    StartEndRadius: "borderStartEndRadius";
    StartStartRadius: "borderStartStartRadius";
    Style: "borderStyle";
    Top: "borderTop";
    TopColor: "borderTopColor";
    TopLeftRadius: "borderTopLeftRadius";
    TopRightRadius: "borderTopRightRadius";
    TopStyle: "borderTopStyle";
    TopWidth: "borderTopWidth";
    Width: "borderWidth";
  };
  borderBlock: {
    Color: "borderBlockColor";
    Style: "borderBlockStyle";
    Width: "borderBlockWidth";
    End: "borderBlockEnd";
    EndColor: "borderBlockEndColor";
    EndStyle: "borderBlockEndStyle";
    EndWidth: "borderBlockEndWidth";
    Start: "borderBlockStart";
    StartColor: "borderBlockStartColor";
    StartStyle: "borderBlockStartStyle";
    StartWidth: "borderBlockStartWidth";
  };
  borderBlockEnd: {
    Color: "borderBlockEndColor";
    Style: "borderBlockEndStyle";
    Width: "borderBlockEndWidth";
  };
  borderBlockStart: {
    Color: "borderBlockStartColor";
    Style: "borderBlockStartStyle";
    Width: "borderBlockStartWidth";
  };
  borderBottom: {
    Color: "borderBottomColor";
    LeftRadius: "borderBottomLeftRadius";
    RightRadius: "borderBottomRightRadius";
    Style: "borderBottomStyle";
    Width: "borderBottomWidth";
  };
  borderImage: {
    Outset: "borderImageOutset";
    Repeat: "borderImageRepeat";
    Slice: "borderImageSlice";
    Source: "borderImageSource";
    Width: "borderImageWidth";
  };
  borderInline: {
    End: "borderInlineEnd";
    Color: "borderInlineColor";
    Style: "borderInlineStyle";
    Width: "borderInlineWidth";
    EndColor: "borderInlineEndColor";
    EndStyle: "borderInlineEndStyle";
    EndWidth: "borderInlineEndWidth";
    Start: "borderInlineStart";
    StartColor: "borderInlineStartColor";
    StartStyle: "borderInlineStartStyle";
    StartWidth: "borderInlineStartWidth";
  };
  borderInlineEnd: {
    Color: "borderInlineEndColor";
    Style: "borderInlineEndStyle";
    Width: "borderInlineEndWidth";
  };
  borderInlineStart: {
    Color: "borderInlineStartColor";
    Style: "borderInlineStartStyle";
    Width: "borderInlineStartWidth";
  };
  borderLeft: {
    Color: "borderLeftColor";
    Style: "borderLeftStyle";
    Width: "borderLeftWidth";
  };
  borderRight: {
    Color: "borderRightColor";
    Style: "borderRightStyle";
    Width: "borderRightWidth";
  };
  borderTop: {
    Color: "borderTopColor";
    LeftRadius: "borderTopLeftRadius";
    RightRadius: "borderTopRightRadius";
    Style: "borderTopStyle";
    Width: "borderTopWidth";
  };
  boxFlex: {
    Group: "boxFlexGroup";
  };
  caret: {
    Color: "caretColor";
    Shape: "caretShape";
  };
  clip: {
    Path: "clipPath";
  };
  color: {
    Scheme: "colorScheme";
  };
  columnRule: {
    Color: "columnRuleColor";
    Style: "columnRuleStyle";
    Width: "columnRuleWidth";
  };
  contain: {
    IntrinsicSize: "containIntrinsicSize";
    IntrinsicBlockSize: "containIntrinsicBlockSize";
    IntrinsicHeight: "containIntrinsicHeight";
    IntrinsicInlineSize: "containIntrinsicInlineSize";
    IntrinsicWidth: "containIntrinsicWidth";
  };
  container: {
    Name: "containerName";
    Type: "containerType";
  };
  content: {
    Visibility: "contentVisibility";
  };
  flex: {
    Basis: "flexBasis";
    Direction: "flexDirection";
    Flow: "flexFlow";
    Grow: "flexGrow";
    Shrink: "flexShrink";
    Wrap: "flexWrap";
  };
  font: {
    Family: "fontFamily";
    FeatureSettings: "fontFeatureSettings";
    Kerning: "fontKerning";
    LanguageOverride: "fontLanguageOverride";
    OpticalSizing: "fontOpticalSizing";
    Palette: "fontPalette";
    VariationSettings: "fontVariationSettings";
    Size: "fontSize";
    SizeAdjust: "fontSizeAdjust";
    Smooth: "fontSmooth";
    Stretch: "fontStretch";
    Style: "fontStyle";
    Synthesis: "fontSynthesis";
    SynthesisPosition: "fontSynthesisPosition";
    SynthesisSmallCaps: "fontSynthesisSmallCaps";
    SynthesisStyle: "fontSynthesisStyle";
    SynthesisWeight: "fontSynthesisWeight";
    Variant: "fontVariant";
    VariantAlternates: "fontVariantAlternates";
    VariantCaps: "fontVariantCaps";
    VariantEastAsian: "fontVariantEastAsian";
    VariantEmoji: "fontVariantEmoji";
    VariantLigatures: "fontVariantLigatures";
    VariantNumeric: "fontVariantNumeric";
    VariantPosition: "fontVariantPosition";
    Weight: "fontWeight";
  };
  fontSize: {
    Adjust: "fontSizeAdjust";
  };
  fontSynthesis: {
    Position: "fontSynthesisPosition";
    SmallCaps: "fontSynthesisSmallCaps";
    Style: "fontSynthesisStyle";
    Weight: "fontSynthesisWeight";
  };
  fontVariant: {
    Alternates: "fontVariantAlternates";
    Caps: "fontVariantCaps";
    EastAsian: "fontVariantEastAsian";
    Emoji: "fontVariantEmoji";
    Ligatures: "fontVariantLigatures";
    Numeric: "fontVariantNumeric";
    Position: "fontVariantPosition";
  };
  grid: {
    Area: "gridArea";
    AutoColumns: "gridAutoColumns";
    AutoFlow: "gridAutoFlow";
    AutoRows: "gridAutoRows";
    Column: "gridColumn";
    ColumnEnd: "gridColumnEnd";
    ColumnGap: "gridColumnGap";
    ColumnStart: "gridColumnStart";
    Gap: "gridGap";
    Row: "gridRow";
    RowEnd: "gridRowEnd";
    RowGap: "gridRowGap";
    RowStart: "gridRowStart";
    Template: "gridTemplate";
    TemplateAreas: "gridTemplateAreas";
    TemplateColumns: "gridTemplateColumns";
    TemplateRows: "gridTemplateRows";
  };
  gridColumn: {
    End: "gridColumnEnd";
    Gap: "gridColumnGap";
    Start: "gridColumnStart";
  };
  gridRow: {
    End: "gridRowEnd";
    Gap: "gridRowGap";
    Start: "gridRowStart";
  };
  gridTemplate: {
    Areas: "gridTemplateAreas";
    Columns: "gridTemplateColumns";
    Rows: "gridTemplateRows";
  };
  initialLetter: {
    Align: "initialLetterAlign";
  };
  inset: {
    Block: "insetBlock";
    BlockEnd: "insetBlockEnd";
    BlockStart: "insetBlockStart";
    Inline: "insetInline";
    InlineEnd: "insetInlineEnd";
    InlineStart: "insetInlineStart";
  };
  insetBlock: {
    End: "insetBlockEnd";
    Start: "insetBlockStart";
  };
  insetInline: {
    End: "insetInlineEnd";
    Start: "insetInlineStart";
  };
  lineHeight: {
    Step: "lineHeightStep";
  };
  listStyle: {
    Image: "listStyleImage";
    Position: "listStylePosition";
    Type: "listStyleType";
  };
  margin: {
    Block: "marginBlock";
    BlockEnd: "marginBlockEnd";
    BlockStart: "marginBlockStart";
    Bottom: "marginBottom";
    Inline: "marginInline";
    InlineEnd: "marginInlineEnd";
    InlineStart: "marginInlineStart";
    Left: "marginLeft";
    Right: "marginRight";
    Top: "marginTop";
    Trim: "marginTrim";
  };
  marginBlock: {
    End: "marginBlockEnd";
    Start: "marginBlockStart";
  };
  marginInline: {
    End: "marginInlineEnd";
    Start: "marginInlineStart";
  };
  mask: {
    Border: "maskBorder";
    BorderMode: "maskBorderMode";
    BorderOutset: "maskBorderOutset";
    BorderRepeat: "maskBorderRepeat";
    BorderSlice: "maskBorderSlice";
    BorderSource: "maskBorderSource";
    BorderWidth: "maskBorderWidth";
    Clip: "maskClip";
    Composite: "maskComposite";
    Image: "maskImage";
    Mode: "maskMode";
    Origin: "maskOrigin";
    Position: "maskPosition";
    Repeat: "maskRepeat";
    Size: "maskSize";
    Type: "maskType";
  };
  maskBorder: {
    Mode: "maskBorderMode";
    Outset: "maskBorderOutset";
    Repeat: "maskBorderRepeat";
    Slice: "maskBorderSlice";
    Source: "maskBorderSource";
    Width: "maskBorderWidth";
  };
  offset: {
    Anchor: "offsetAnchor";
    Distance: "offsetDistance";
    Path: "offsetPath";
    Position: "offsetPosition";
    Rotate: "offsetRotate";
  };
  outline: {
    Color: "outlineColor";
    Offset: "outlineOffset";
    Style: "outlineStyle";
    Width: "outlineWidth";
  };
  overflow: {
    Anchor: "overflowAnchor";
    Block: "overflowBlock";
    ClipBox: "overflowClipBox";
    ClipMargin: "overflowClipMargin";
    Inline: "overflowInline";
    Wrap: "overflowWrap";
    X: "overflowX";
    Y: "overflowY";
  };
  overscrollBehavior: {
    Block: "overscrollBehaviorBlock";
    Inline: "overscrollBehaviorInline";
    X: "overscrollBehaviorX";
    Y: "overscrollBehaviorY";
  };
  padding: {
    Block: "paddingBlock";
    BlockEnd: "paddingBlockEnd";
    BlockStart: "paddingBlockStart";
    Bottom: "paddingBottom";
    Inline: "paddingInline";
    InlineEnd: "paddingInlineEnd";
    InlineStart: "paddingInlineStart";
    Left: "paddingLeft";
    Right: "paddingRight";
    Top: "paddingTop";
  };
  paddingBlock: {
    End: "paddingBlockEnd";
    Start: "paddingBlockStart";
  };
  paddingInline: {
    End: "paddingInlineEnd";
    Start: "paddingInlineStart";
  };
  page: {
    BreakAfter: "pageBreakAfter";
    BreakBefore: "pageBreakBefore";
    BreakInside: "pageBreakInside";
  };
  perspective: {
    Origin: "perspectiveOrigin";
  };
  scrollMargin: {
    Block: "scrollMarginBlock";
    BlockStart: "scrollMarginBlockStart";
    BlockEnd: "scrollMarginBlockEnd";
    Bottom: "scrollMarginBottom";
    Inline: "scrollMarginInline";
    InlineStart: "scrollMarginInlineStart";
    InlineEnd: "scrollMarginInlineEnd";
    Left: "scrollMarginLeft";
    Right: "scrollMarginRight";
    Top: "scrollMarginTop";
  };
  scrollMarginBlock: {
    Start: "scrollMarginBlockStart";
    End: "scrollMarginBlockEnd";
  };
  scrollMarginInline: {
    Start: "scrollMarginInlineStart";
    End: "scrollMarginInlineEnd";
  };
  scrollPadding: {
    Block: "scrollPaddingBlock";
    BlockStart: "scrollPaddingBlockStart";
    BlockEnd: "scrollPaddingBlockEnd";
    Bottom: "scrollPaddingBottom";
    Inline: "scrollPaddingInline";
    InlineStart: "scrollPaddingInlineStart";
    InlineEnd: "scrollPaddingInlineEnd";
    Left: "scrollPaddingLeft";
    Right: "scrollPaddingRight";
    Top: "scrollPaddingTop";
  };
  scrollPaddingBlock: {
    Start: "scrollPaddingBlockStart";
    End: "scrollPaddingBlockEnd";
  };
  scrollPaddingInline: {
    Start: "scrollPaddingInlineStart";
    End: "scrollPaddingInlineEnd";
  };
  scrollSnapType: {
    X: "scrollSnapTypeX";
    Y: "scrollSnapTypeY";
  };
  scrollTimeline: {
    Axis: "scrollTimelineAxis";
    Name: "scrollTimelineName";
  };
  textAlign: {
    Last: "textAlignLast";
  };
  textDecoration: {
    Color: "textDecorationColor";
    Line: "textDecorationLine";
    Skip: "textDecorationSkip";
    SkipInk: "textDecorationSkipInk";
    Style: "textDecorationStyle";
    Thickness: "textDecorationThickness";
  };
  textDecorationSkip: {
    Ink: "textDecorationSkipInk";
  };
  textEmphasis: {
    Color: "textEmphasisColor";
    Position: "textEmphasisPosition";
    Style: "textEmphasisStyle";
  };
  transform: {
    Box: "transformBox";
    Origin: "transformOrigin";
    Style: "transformStyle";
  };
  transition: {
    Behavior: "transitionBehavior";
    Delay: "transitionDelay";
    Duration: "transitionDuration";
    Property: "transitionProperty";
    TimingFunction: "transitionTimingFunction";
  };
  viewTimeline: {
    Axis: "viewTimelineAxis";
    Inset: "viewTimelineInset";
    Name: "viewTimelineName";
  };
  whiteSpace: {
    Collapse: "whiteSpaceCollapse";
    Trim: "whiteSpaceTrim";
  };
};
