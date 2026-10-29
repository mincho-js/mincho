import { choice, fail, number } from "./diagnostics.js";
import type {
  BoxOptions,
  ItemRequirements,
  NativeStyle,
  NormalizedSize,
  Padding,
  StackOptions,
  Stretch
} from "./types.js";

/** A common scale keeps every supported stretch factor >= 1, even alone on a line. */
export const growFactor = 1e4;
export function stretchGrow(weight: number): number {
  const grow = weight * growFactor;
  if (!Number.isFinite(grow) || grow < 1)
    fail(
      "E_INVALID_NUMBER",
      `Stretch weights must be at least ${1 / growFactor} and produce a finite grow factor.`
    );
  return grow;
}

export function normalizeSize(value: unknown = "hug-contents"): NormalizedSize {
  if (typeof value === "number")
    return { kind: "fixed", value: number(value, "size") };
  if (value === "hug-contents") return { kind: "content" };
  if (value === "stretch")
    return { kind: "stretch", weight: 1, explicitWeight: false };
  if (
    typeof value === "object" &&
    value !== null &&
    "mode" in value &&
    value.mode === "stretch"
  ) {
    const stretch = value as Exclude<Stretch, string>;
    return {
      kind: "stretch",
      weight: number(stretch.weight ?? 1, "stretch weight", true),
      explicitWeight: stretch.weight !== undefined
    };
  }
  if (
    typeof value === "string" &&
    /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%$/i.test(value)
  ) {
    return {
      kind: "percent",
      ratio: number(Number(value.slice(0, -1)), "percentage") / 100
    };
  }
  fail("E_INVALID_NUMBER", `Invalid size: ${String(value)}.`);
}

const paddingGroups = [
  ["horizontal", "vertical"],
  ["top", "right", "bottom", "left"],
  ["inline", "block"],
  ["inlineStart", "inlineEnd", "blockStart", "blockEnd"]
] as const;

export function normalizePadding(value: Padding = 0) {
  const style: NativeStyle = {};
  if (typeof value === "number") {
    const size = number(value, "padding");
    return {
      style: { padding: size },
      horizontal: size * 2,
      vertical: size * 2
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("E_INVALID_PADDING", "padding must be a number or one padding form.");
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  const group = paddingGroups.find((keys) =>
    entries.every(([k]) => (keys as readonly string[]).includes(k))
  );
  if (!group)
    fail("E_INVALID_PADDING", "Do not mix physical and logical padding forms.");
  const values = Object.fromEntries(
    entries.map(([k, v]) => [k, number(v, `padding.${k}`)])
  );
  let horizontal = 0;
  let vertical = 0;
  for (const [key, size] of Object.entries(values)) {
    if (key === "horizontal") {
      style.paddingLeft = style.paddingRight = size;
      horizontal += 2 * size;
    } else if (key === "vertical") {
      style.paddingTop = style.paddingBottom = size;
      vertical += 2 * size;
    } else if (key === "inline" || key === "block") {
      style[`padding${key[0].toUpperCase()}${key.slice(1)}`] = size;
      if (key === "inline") horizontal += 2 * size;
      else vertical += 2 * size;
    } else {
      style[`padding${key[0].toUpperCase()}${key.slice(1)}`] = size;
      if (["left", "right", "inlineStart", "inlineEnd"].includes(key))
        horizontal += size;
      else vertical += size;
    }
  }
  return { style, horizontal, vertical };
}

export function normalizeBox(props: BoxOptions = {}) {
  const width = normalizeSize(props.width);
  const height = normalizeSize(props.height);
  const padding = normalizePadding(props.padding);
  const minWidth = Math.max(
    number(props.minWidth ?? 0, "minWidth"),
    padding.horizontal
  );
  const minHeight = Math.max(
    number(props.minHeight ?? 0, "minHeight"),
    padding.vertical
  );
  const maxWidth =
    props.maxWidth === undefined
      ? Infinity
      : number(props.maxWidth, "maxWidth");
  const maxHeight =
    props.maxHeight === undefined
      ? Infinity
      : number(props.maxHeight, "maxHeight");
  if (minWidth > maxWidth || minHeight > maxHeight) {
    fail(
      "E_INVALID_BOUNDS",
      "Minimum size and padding must fit within the maximum size."
    );
  }
  const position = choice(
    props.position ?? "flow",
    ["flow", "relative", "absolute"],
    "position"
  );
  const relations = props as ItemRequirements;
  if (
    position === "absolute" &&
    [
      props.shrink,
      props.alignSelf,
      relations.gapBefore,
      relations.gapAfter,
      relations.breakBefore,
      relations.breakAfter
    ].some((v) => v !== undefined)
  ) {
    fail(
      "E_INVALID_PLACEMENT",
      "Absolute items cannot declare flow placement or relations."
    );
  }
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    if (props[edge] !== undefined) {
      if (position !== "absolute")
        fail("E_INVALID_PLACEMENT", "Insets require position=absolute.");
      if (typeof props[edge] !== "number" || !Number.isFinite(props[edge])) {
        fail("E_INVALID_NUMBER", `${edge} must be a finite number.`);
      }
    }
  }
  if (props.shrink !== undefined && typeof props.shrink !== "boolean") {
    if (!props.shrink || typeof props.shrink !== "object")
      fail("E_INVALID_NUMBER", "Invalid shrink.");
    number(props.shrink.weight ?? 1, "shrink weight", true);
  }
  const alignSelf = choice(
    props.alignSelf ?? "auto",
    ["auto", "start", "center", "end", "baseline"],
    "alignSelf"
  );
  const overflow = choice(
    props.overflow ?? "visible",
    ["visible", "clip", "auto", "scroll"],
    "overflow"
  );
  if (props.direction !== undefined)
    choice(props.direction, ["ltr", "rtl"], "direction");
  return {
    props,
    width,
    height,
    padding,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
    position,
    alignSelf,
    overflow
  };
}

export function normalizeStack(props: StackOptions) {
  const box = normalizeBox(props);
  const axis = choice(props.axis, ["horizontal", "vertical"], "axis");
  const gap = number(props.gap ?? 0, "gap");
  if (props.wrap !== undefined && typeof props.wrap !== "boolean")
    fail("E_LAYOUT_CAPABILITY", "wrap must be boolean.");
  const wrap = props.wrap ?? false;
  if (
    !wrap &&
    (props.lineGap !== undefined || props.alignLines !== undefined)
  ) {
    fail("E_WRAP_ONLY_PROP", "lineGap and alignLines require wrap=true.");
  }
  const lineGap = number(props.lineGap ?? gap, "lineGap");
  const align = choice(
    props.align ?? "start",
    ["start", "center", "end", "baseline"],
    "align"
  );
  if (axis === "vertical" && align === "baseline")
    fail(
      "E_UNSUPPORTED_BASELINE",
      "VStack does not support baseline alignment."
    );
  const justify = choice(
    props.justify ?? "start",
    ["start", "center", "end", "between", "around", "evenly"],
    "justify"
  );
  const alignLines = choice(
    props.alignLines ?? "start",
    ["start", "center", "end", "between", "around", "evenly"],
    "alignLines"
  );
  if (wrap && axis === "vertical" && box.height.kind === "content") {
    fail(
      "E_LAYOUT_CAPABILITY",
      "Vertical wrapping requires an independently definite height."
    );
  }
  return {
    ...box,
    props,
    axis,
    gap,
    wrap,
    lineGap,
    align,
    justify,
    alignLines
  };
}

export type NormalizedBox = ReturnType<typeof normalizeBox>;
export type NormalizedStack = ReturnType<typeof normalizeStack>;

export function cssSize(size: NormalizedSize): number | string {
  switch (size.kind) {
    case "fixed":
      return size.value;
    case "percent":
      return `${size.ratio * 100}%`;
    case "content":
      return "fit-content";
    case "stretch":
      return "100%";
  }
}

export function mainSize(box: NormalizedBox, parent: NormalizedStack) {
  return parent.axis === "horizontal" ? box.width : box.height;
}

export function canShrink(
  box: NormalizedBox,
  parent: NormalizedStack
): boolean {
  // Declared and hugging sizes are kept unless an item opts in.
  const { shrink } = box.props;
  return (
    mainSize(box, parent).kind !== "stretch" &&
    shrink !== undefined &&
    shrink !== false
  );
}

export function nativeBox(
  box: NormalizedBox,
  parent?: NormalizedStack
): NativeStyle {
  const style: NativeStyle = {
    boxSizing: "border-box",
    width: cssSize(box.width),
    height: cssSize(box.height),
    minWidth: box.minWidth,
    minHeight: box.minHeight,
    maxWidth: box.maxWidth === Infinity ? "none" : box.maxWidth,
    maxHeight: box.maxHeight === Infinity ? "none" : box.maxHeight,
    margin: 0,
    padding: 0,
    ...box.padding.style,
    position: box.position === "flow" ? "static" : box.position,
    overflow: box.overflow
  };
  if (box.props.direction !== undefined) style.direction = box.props.direction;
  if (box.position === "absolute") {
    for (const key of ["top", "right", "bottom", "left"] as const) {
      if (box.props[key] !== undefined) style[key] = box.props[key];
    }
    return style;
  }
  if (!parent) {
    if (box.props.shrink !== undefined || box.props.alignSelf !== undefined) {
      fail(
        "E_INVALID_ITEM_PARENT",
        "shrink and alignSelf require a parent Stack."
      );
    }
    return style;
  }
  for (const dimension of ["width", "height"] as const) {
    if (
      box[dimension].kind === "percent" &&
      parent[dimension].kind === "content"
    ) {
      fail(
        "E_PERCENT_DEPENDENCY",
        `${dimension} percentage depends on a hugging parent.`
      );
    }
  }
  const main = mainSize(box, parent);
  const mainKey = parent.axis === "horizontal" ? "width" : "height";
  const crossKey = parent.axis === "horizontal" ? "height" : "width";
  const cross = box[crossKey];
  if (
    main.kind === "stretch" &&
    box.props.shrink !== undefined &&
    box.props.shrink !== false
  ) {
    fail(
      "E_INVALID_PLACEMENT",
      "Main-axis stretch cannot be combined with shrink."
    );
  }
  if (main.kind === "stretch" && parent[mainKey].kind === "content") {
    fail(
      "E_LAYOUT_CAPABILITY",
      "Main-axis stretch requires an independently definite parent size."
    );
  }
  if (box.alignSelf === "baseline" && parent.axis === "vertical") {
    fail(
      "E_UNSUPPORTED_BASELINE",
      "VStack items cannot use baseline alignment."
    );
  }
  if (cross.kind === "stretch") {
    if (cross.explicitWeight)
      fail(
        "E_LAYOUT_CAPABILITY",
        "Cross-axis stretch does not accept a weight."
      );
    if (box.alignSelf !== "auto")
      fail("E_INVALID_PLACEMENT", "Cross stretch cannot override alignSelf.");
    if (parent.align === "baseline")
      fail(
        "E_UNSUPPORTED_BASELINE",
        "Baseline alignment conflicts with cross stretch."
      );
    style[crossKey] = "auto";
    style.alignSelf = "stretch";
  } else {
    style.alignSelf =
      box.alignSelf === "auto" ? "auto" : alignment(box.alignSelf);
  }
  style.flexBasis = main.kind === "stretch" ? 0 : "auto";
  style.flexGrow = main.kind === "stretch" ? stretchGrow(main.weight) : 0;
  style.flexShrink = canShrink(box, parent) ? 1 : 0;
  if (main.kind === "stretch") style[mainKey] = 0;
  else if (main.kind === "content") style[mainKey] = "max-content";
  return style;
}

export function alignment(value: string): string {
  if (value === "start") return "flex-start";
  if (value === "center" || value === "end")
    return `safe ${value === "end" ? "flex-end" : value}`;
  return value;
}

export function distribution(value: string): string {
  return ["between", "around", "evenly"].includes(value)
    ? `space-${value}`
    : alignment(value);
}

export function nativeStack(
  stack: NormalizedStack,
  parent?: NormalizedStack
): NativeStyle {
  return {
    ...nativeBox(stack, parent),
    display: "flex",
    flexDirection: stack.axis === "horizontal" ? "row" : "column",
    flexWrap: stack.wrap ? "wrap" : "nowrap",
    columnGap: stack.axis === "horizontal" ? stack.gap : stack.lineGap,
    rowGap: stack.axis === "horizontal" ? stack.lineGap : stack.gap,
    justifyContent: distribution(stack.justify),
    alignItems: alignment(stack.align),
    ...(stack.wrap ? { alignContent: distribution(stack.alignLines) } : {})
  };
}
