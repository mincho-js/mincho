import { fail } from "./diagnostics.js";
import {
  alignment,
  cssSize,
  distribution,
  nativeBox,
  nativeStack,
  normalizeBox,
  normalizeStack,
  stretchGrow
} from "./normalize.js";
import type { NormalizedBox, NormalizedStack } from "./normalize.js";
import { normalizeBoundarySpace, normalizeBreakPolicy } from "./relations.js";
import { layoutVars as v } from "./stylesheet.js";
import type {
  ItemRequirements,
  NativeStyle,
  NormalizedSize,
  StackOptions
} from "./types.js";

export type LayoutKind = "Box" | "Stack" | "HStack" | "VStack" | "Item";
export type LayoutProps = ItemRequirements &
  Partial<Omit<StackOptions, keyof ItemRequirements>>;

export function isStackKind(kind: LayoutKind) {
  return kind === "Stack" || kind === "HStack" || kind === "VStack";
}

const px = (value: number | string) =>
  typeof value === "number" ? `${value}px` : value;

const sizeVars = {
  horizontal: {
    main: v.widthMain,
    cross: v.heightCross,
    grow: v.growWidth,
    shrink: v.shrinkWidth,
    basis: v.basisWidth,
    self: v.selfHeight
  },
  vertical: {
    main: v.heightMain,
    cross: v.widthCross,
    grow: v.growHeight,
    shrink: v.shrinkHeight,
    basis: v.basisHeight,
    self: v.selfWidth
  }
} as const;

/** Declarations for each possible parent axis, as variables the stylesheet selects. */
function placementVars(box: NormalizedBox, style: NativeStyle) {
  const natural = {
    width: px(cssSize(box.width)),
    height: px(cssSize(box.height))
  };
  style[v.width] = natural.width;
  style[v.height] = natural.height;
  if (box.position === "absolute") return;
  for (const axis of ["horizontal", "vertical"] as const) {
    const names = sizeVars[axis];
    const [mainKey, crossKey] =
      axis === "horizontal"
        ? (["width", "height"] as const)
        : (["height", "width"] as const);
    const main: NormalizedSize = box[mainKey];
    const cross: NormalizedSize = box[crossKey];
    const mainCss =
      main.kind === "stretch"
        ? "0px"
        : main.kind === "content"
          ? "max-content"
          : natural[mainKey];
    if (mainCss !== natural[mainKey]) style[names.main] = mainCss;
    if (cross.kind === "stretch") style[names.cross] = "auto";
    if (main.kind === "stretch") {
      style[names.grow] = String(stretchGrow(main.weight));
      style[names.basis] = "0px";
    } else if (box.props.shrink !== undefined && box.props.shrink !== false)
      style[names.shrink] = "1";
    const self =
      cross.kind === "stretch"
        ? "stretch"
        : box.alignSelf === "auto"
          ? undefined
          : alignment(box.alignSelf);
    if (self) style[names.self] = self;
  }
}

/**
 * Normalizes props and returns native declarations that do not depend on the
 * parent. Runtime components apply them inline and compiled output as a
 * class; checks that need the parent run only in development (`checkParent`).
 */
export function resolveLayout(kind: LayoutKind, props: LayoutProps) {
  const stackKind = isStackKind(kind);
  const stack = stackKind
    ? normalizeStack({
        ...props,
        axis:
          kind === "HStack"
            ? "horizontal"
            : kind === "VStack"
              ? "vertical"
              : props.axis!
      } as StackOptions)
    : undefined;
  const box: NormalizedBox = stack ?? normalizeBox(props);
  if (
    !stackKind &&
    [
      props.gap,
      props.justify,
      props.align,
      props.wrap,
      props.lineGap,
      props.alignLines,
      props.axis
    ].some((value) => value !== undefined)
  ) {
    fail(
      "E_LAYOUT_CAPABILITY",
      "Box and Item do not arrange their children as a Stack."
    );
  }
  const relations = [props.gapBefore, props.gapAfter];
  const breaks = [props.breakBefore, props.breakAfter];
  if (
    kind !== "Item" &&
    [...relations, ...breaks].some((value) => value !== undefined)
  )
    fail("E_LAYOUT_CAPABILITY", "Sibling relations belong to Item.");

  const style: NativeStyle = {
    minWidth: box.minWidth,
    minHeight: box.minHeight,
    maxWidth: box.maxWidth === Infinity ? "none" : box.maxWidth,
    maxHeight: box.maxHeight === Infinity ? "none" : box.maxHeight,
    padding: 0,
    ...box.padding.style,
    position: box.position === "flow" ? "static" : box.position,
    overflow: box.overflow
  };
  if (props.direction !== undefined) style.direction = props.direction;
  if (box.position === "absolute")
    for (const key of ["top", "right", "bottom", "left"] as const)
      if (props[key] !== undefined) style[key] = props[key];
  placementVars(box, style);

  if (stack) {
    style.flexWrap = stack.wrap ? "wrap" : "nowrap";
    style.columnGap = stack.axis === "horizontal" ? stack.gap : stack.lineGap;
    style.rowGap = stack.axis === "horizontal" ? stack.lineGap : stack.gap;
    style.justifyContent = distribution(stack.justify);
    style.alignItems = alignment(stack.align);
    if (stack.wrap) style.alignContent = distribution(stack.alignLines);
    style[v.gap] = `${stack.gap}px`;
  }

  for (const [index, value] of relations.entries()) {
    if (value === undefined) continue;
    const space = normalizeBoundarySpace(value, 0);
    const bounded =
      typeof value === "object" &&
      "size" in value &&
      value.minSize !== undefined;
    if (
      space.kind === "stretch" &&
      (space.weight !== 1 || space.max !== Infinity || bounded)
    )
      fail(
        "E_LAYOUT_CAPABILITY",
        "Weighted/bounded spaces require precision allocation."
      );
    // The stylesheet decides from actual siblings whether a fixed space is at
    // an edge; auto spaces do not depend on position.
    if (space.kind === "fixed")
      style[index === 0 ? v.before : v.after] = `${space.value}px`;
    else style[index === 0 ? v.beforeAuto : v.afterAuto] = "auto";
  }
  for (const value of breaks)
    if (normalizeBreakPolicy(value) !== "allow")
      fail(
        "E_LAYOUT_CAPABILITY",
        "Strong breaks require the precision renderer."
      );

  return { stack, box, style };
}

/**
 * Development checks that need the parent's semantics. The style mapping
 * functions throw the same diagnostics the class-name patterns use.
 */
export function checkParent(
  kind: LayoutKind,
  props: LayoutProps,
  box: NormalizedBox,
  stack: NormalizedStack | undefined,
  parent: NormalizedStack | undefined
) {
  if (kind === "Item" && !parent)
    fail("E_INVALID_ITEM_PARENT", "Item must belong to a Stack.");
  if (stack) nativeStack(stack, parent);
  else nativeBox(box, parent);
  if (kind !== "Item" || !parent) return;
  const spaces = [props.gapBefore, props.gapAfter].filter(
    (value) => value !== undefined
  );
  if (spaces.length && ["between", "around", "evenly"].includes(parent.justify))
    fail(
      "E_MIXED_SPACE_DISTRIBUTION",
      "Explicit item spacing cannot use distributed justify."
    );
  for (const value of [props.breakBefore, props.breakAfter])
    if (normalizeBreakPolicy(value) === "force" && !parent.wrap)
      fail("E_FORCE_WITHOUT_WRAP", "force requires wrap=true.");
  if (parent.wrap && spaces.length)
    fail(
      "E_LAYOUT_CAPABILITY",
      "Wrapped relations require the precision renderer."
    );
}
