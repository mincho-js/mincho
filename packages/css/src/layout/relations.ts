import { choice, fail, number } from "./diagnostics.js";
import {
  canShrink,
  mainSize,
  nativeBox,
  normalizeBox,
  normalizeSize
} from "./normalize.js";
import type { NormalizedBox, NormalizedStack } from "./normalize.js";
import type {
  PrecisionBoundarySpace,
  PrecisionBreakPolicy,
  CanonicalBoundary,
  EdgeSpace,
  ItemRequirements,
  LayoutItem,
  NativeStyle,
  NormalizedSpace
} from "./types.js";

export function normalizeBoundarySpace(
  value: PrecisionBoundarySpace,
  defaultMin: number
): NormalizedSpace {
  if (typeof value === "number")
    return { kind: "fixed", value: number(value, "boundary space") };
  const bounded =
    typeof value === "object" && value !== null && "size" in value
      ? value
      : undefined;
  const size = normalizeSize(bounded ? bounded.size : value);
  if (size.kind !== "stretch")
    fail("E_INVALID_NUMBER", "A variable boundary must use stretch.");
  const min = number(bounded?.minSize ?? defaultMin, "boundary minSize");
  const max =
    bounded?.maxSize === undefined
      ? Infinity
      : number(bounded.maxSize, "boundary maxSize");
  if (min > max) fail("E_INVALID_BOUNDS", "Boundary minSize exceeds maxSize.");
  return { kind: "stretch", weight: size.weight, min, max };
}

export function normalizeBreakPolicy(value: PrecisionBreakPolicy | undefined) {
  return choice(value ?? "allow", ["allow", "never", "force"], "break policy");
}

/** Input order must match actual, visible, direct DOM flow items. */
export function normalizeRelations(
  parent: NormalizedStack,
  items: readonly LayoutItem[]
) {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id))
      fail("E_UNSUPPORTED_DOM_CHILD", "Layout item IDs must be unique.", {
        itemId: item.id
      });
    ids.add(item.id);
    if (item.props) normalizeBox(item.props);
    for (const value of [item.props?.breakBefore, item.props?.breakAfter]) {
      if (normalizeBreakPolicy(value) === "force" && !parent.wrap) {
        fail("E_FORCE_WITHOUT_WRAP", "force requires wrap=true.", {
          itemId: item.id
        });
      }
    }
  }
  const flow = items.filter((item) => item.props?.position !== "absolute");
  const boundaries: CanonicalBoundary[] = [];
  const edges: EdgeSpace[] = [];
  for (let i = 0; i < flow.length; i++) {
    const item = flow[i];
    if (i === 0 || i === flow.length - 1) {
      for (const side of ["before", "after"] as const) {
        if (
          (side === "before" && i !== 0) ||
          (side === "after" && i !== flow.length - 1)
        )
          continue;
        const breakValue =
          side === "before" ? item.props?.breakBefore : item.props?.breakAfter;
        if (normalizeBreakPolicy(breakValue) !== "allow")
          fail(
            "E_INVALID_BREAK_EDGE",
            "Break policies cannot target an outer edge.",
            { itemId: item.id }
          );
        const value =
          side === "before" ? item.props?.gapBefore : item.props?.gapAfter;
        if (value !== undefined)
          edges.push({
            itemId: item.id,
            side,
            space: normalizeBoundarySpace(value, 0)
          });
      }
    }
    if (i === 0) continue;
    const previous = flow[i - 1];
    const after = previous.props?.gapAfter;
    const before = item.props?.gapBefore;
    const boundaryId = `${previous.id}:${item.id}`;
    if (before !== undefined && after !== undefined) {
      fail(
        "E_DUPLICATE_BOUNDARY_SPACE",
        "Both neighbors define the same space.",
        { boundaryId }
      );
    }
    const breakAfter = normalizeBreakPolicy(previous.props?.breakAfter);
    const breakBefore = normalizeBreakPolicy(item.props?.breakBefore);
    if (breakAfter !== "allow" && breakBefore !== "allow") {
      fail("E_DUPLICATE_BREAK", "Both neighbors define the same break.", {
        boundaryId
      });
    }
    const breakPolicy = breakBefore !== "allow" ? breakBefore : breakAfter;
    const declaredBy =
      before !== undefined
        ? "before"
        : after !== undefined
          ? "after"
          : "parent-gap";
    if (breakPolicy === "force" && declaredBy !== "parent-gap") {
      fail("E_FORCE_WITH_EXPLICIT_SPACE", "Use lineGap at a forced break.", {
        boundaryId
      });
    }
    boundaries.push({
      previousId: previous.id,
      nextId: item.id,
      declaredBy,
      breakPolicy,
      space:
        before !== undefined
          ? normalizeBoundarySpace(before, parent.gap)
          : after !== undefined
            ? normalizeBoundarySpace(after, parent.gap)
            : { kind: "fixed", value: parent.gap }
    });
  }
  const explicit =
    edges.length > 0 || boundaries.some((b) => b.declaredBy !== "parent-gap");
  if (explicit && ["between", "around", "evenly"].includes(parent.justify)) {
    fail(
      "E_MIXED_SPACE_DISTRIBUTION",
      "Explicit item spacing cannot use distributed justify."
    );
  }
  if (explicit && flow.length !== items.length) {
    fail(
      "E_UNSUPPORTED_DOM_CHILD",
      "Move absolute overlays inside a relative Box when using relations."
    );
  }
  return { flow, boundaries, edges, explicit };
}

/**
 * Order-independent checks over layout-managed participants. The React renderer
 * runs them from registered Item props, without reading the DOM.
 */
export function nativeParticipants(
  parent: NormalizedStack,
  boxes: readonly NormalizedBox[]
) {
  const flow = boxes.filter((box) => box.position !== "absolute");
  const stretching = flow.filter(
    (box) => mainSize(box, parent).kind === "stretch"
  );
  if (flow.filter((box) => canShrink(box, parent)).length > 1) {
    fail(
      "E_LAYOUT_CAPABILITY",
      "Multiple shrink participants need the precision renderer's pixel-ratio allocation. Declare shrink on one yielding item."
    );
  }
  if (
    stretching.length > 1 &&
    stretching.some(
      (box) =>
        (parent.axis === "horizontal"
          ? box.padding.horizontal
          : box.padding.vertical) > 0
    )
  ) {
    fail(
      "E_LAYOUT_CAPABILITY",
      "Stretch ratios with item insets require precision allocation. Put padding in a nested Box."
    );
  }
  const variableSpace = flow.some((box) => {
    const { gapBefore, gapAfter } = box.props as ItemRequirements;
    return [gapBefore, gapAfter].some(
      (value) => value !== undefined && typeof value !== "number"
    );
  });
  if (variableSpace && stretching.length > 0)
    fail(
      "E_LAYOUT_CAPABILITY",
      "Variable spaces competing with stretch items require precision allocation."
    );
  return { stretching };
}

/** Returns CSS only when the renderer can honor the requested semantics. */
export function nativeItems(
  parent: NormalizedStack,
  items: readonly LayoutItem[]
) {
  const canonical = normalizeRelations(parent, items);
  const normalized = items.map((item) =>
    item.props ? normalizeBox(item.props) : undefined
  );
  const styles: NativeStyle[] = normalized.map((box) =>
    box ? nativeBox(box, parent) : {}
  );
  const { stretching } = nativeParticipants(
    parent,
    normalized.filter((box) => box !== undefined)
  );
  if (parent.wrap && canonical.explicit)
    fail(
      "E_LAYOUT_CAPABILITY",
      "Wrapped item spacing needs precision line formation."
    );
  if (
    canonical.boundaries.some((boundary) => boundary.breakPolicy !== "allow")
  ) {
    fail(
      "E_LAYOUT_CAPABILITY",
      "Strong break policies require the precision renderer."
    );
  }
  const apply = (
    id: string,
    side: "before" | "after",
    value: NormalizedSpace,
    edge: boolean
  ) => {
    const key =
      parent.axis === "horizontal"
        ? side === "before"
          ? "marginInlineStart"
          : "marginInlineEnd"
        : side === "before"
          ? "marginBlockStart"
          : "marginBlockEnd";
    const defaultMin = edge ? 0 : parent.gap;
    if (value.kind === "stretch") {
      if (
        value.weight !== 1 ||
        value.min !== defaultMin ||
        value.max !== Infinity ||
        stretching.length > 0
      ) {
        fail(
          "E_LAYOUT_CAPABILITY",
          "Weighted/bounded spaces or competing stretch items require precision allocation.",
          { itemId: id }
        );
      }
      styles[items.findIndex((item) => item.id === id)][key] = "auto";
    } else {
      styles[items.findIndex((item) => item.id === id)][key] =
        value.value - defaultMin;
    }
  };
  for (const edge of canonical.edges)
    apply(edge.itemId, edge.side, edge.space, true);
  for (const boundary of canonical.boundaries) {
    if (boundary.declaredBy === "before")
      apply(boundary.nextId, "before", boundary.space, false);
    if (boundary.declaredBy === "after")
      apply(boundary.previousId, "after", boundary.space, false);
  }
  return { ...canonical, styles, path: "native" as const };
}
