import { describe, expect, it } from "vitest";
import {
  LayoutError,
  nativeBox,
  nativeItems,
  nativeStack,
  normalizeBox,
  normalizeRelations,
  normalizeStack
} from "./core.js";
import type { ItemRequirements, StackOptions } from "./types.js";

const row = (props: Partial<StackOptions> = {}) =>
  normalizeStack({ axis: "horizontal", width: 400, ...props } as StackOptions);
const fixed = (width = 100, props: ItemRequirements = {}) =>
  ({ width, ...props }) as ItemRequirements;

describe("intent normalization", () => {
  it("uses px, border-box and natural flow for Box", () => {
    const box = normalizeBox({ width: 320, padding: 20 });
    expect(nativeBox(box)).toMatchObject({
      width: 320,
      padding: 20,
      minWidth: 40,
      boxSizing: "border-box"
    });
    expect(nativeBox(box)).not.toHaveProperty("display");
    expect(nativeStack(row({ gap: 16, padding: 24 }))).toMatchObject({
      columnGap: 16,
      padding: 24,
      alignItems: "flex-start",
      justifyContent: "flex-start"
    });
  });

  it.each([-1, NaN, Infinity, -Infinity])(
    "rejects invalid lengths %s",
    (value) => {
      expect(() => row({ gap: value })).toThrow("E_INVALID_NUMBER");
      expect(() => normalizeBox({ width: value })).toThrow("E_INVALID_NUMBER");
    }
  );

  it("rejects bounds, padding mixtures, absolute relations and invalid alignment", () => {
    expect(() => normalizeBox({ minWidth: 20, maxWidth: 10 })).toThrow(
      "E_INVALID_BOUNDS"
    );
    expect(() => normalizeBox({ padding: 20, maxWidth: 30 })).toThrow(
      "E_INVALID_BOUNDS"
    );
    expect(() =>
      normalizeBox({ padding: { top: 1, inline: 2 } } as never)
    ).toThrow("E_INVALID_PADDING");
    expect(() =>
      normalizeBox({ position: "absolute", gapAfter: 1 } as never)
    ).toThrow("E_INVALID_PLACEMENT");
    expect(() =>
      normalizeStack({ axis: "vertical", align: "baseline" })
    ).toThrow("E_UNSUPPORTED_BASELINE");
    expect(() => row({ lineGap: 12 })).toThrow("E_WRAP_ONLY_PROP");
    expect(() => row({ alignLines: "start" })).toThrow("E_WRAP_ONLY_PROP");
    expect(() => normalizeStack({ axis: "vertical", wrap: true })).toThrow(
      "E_LAYOUT_CAPABILITY"
    );
  });

  it("uses the parent's axis for placement and rejects percentage cycles", () => {
    const parent = normalizeStack({
      axis: "vertical",
      height: 300,
      width: 100
    });
    expect(nativeStack(row({ height: "stretch" }), parent)).toMatchObject({
      flexDirection: "row",
      height: 0,
      flexGrow: 10000
    });
    expect(() =>
      nativeBox(normalizeBox({ width: "50%" }), row({ width: "hug-contents" }))
    ).toThrow("E_PERCENT_DEPENDENCY");
    expect(() =>
      nativeBox(normalizeBox({ width: "stretch", shrink: true }), row())
    ).toThrow("E_INVALID_PLACEMENT");
    expect(() =>
      nativeBox(normalizeBox({ height: { mode: "stretch", weight: 1 } }), row())
    ).toThrow("E_LAYOUT_CAPABILITY");
  });

  it.each(["horizontal", "vertical"] as const)(
    "accepts explicitly disabled shrink for %s stretch",
    (axis) => {
      const parent = normalizeStack({ axis, width: 400, height: 400 });
      const size = axis === "horizontal" ? "width" : "height";
      expect(
        nativeBox(normalizeBox({ [size]: "stretch", shrink: false }), parent)
      ).toMatchObject({ flexGrow: 10000, flexShrink: 0 });
      for (const shrink of [true, { weight: 1 }]) {
        expect(() =>
          nativeBox(normalizeBox({ [size]: "stretch", shrink }), parent)
        ).toThrow("E_INVALID_PLACEMENT");
      }
    }
  );
});

describe("canonical sibling relations", () => {
  it("T23–T25 replaces gutters and preserves outer edges", () => {
    const result = nativeItems(row({ gap: 12 }), [
      { id: "a", props: fixed(100, { gapBefore: 16, gapAfter: 20 }) },
      { id: "b", props: fixed() },
      { id: "c", props: fixed(100, { gapBefore: 4, gapAfter: 24 }) }
    ]);
    expect(result.boundaries.map((b) => b.space)).toEqual([
      { kind: "fixed", value: 20 },
      { kind: "fixed", value: 4 }
    ]);
    expect(result.styles[0]).toMatchObject({
      marginInlineStart: 16,
      marginInlineEnd: 8
    });
    expect(result.styles[2]).toMatchObject({
      marginInlineStart: -8,
      marginInlineEnd: 24
    });
  });

  it("T28 a newly first item keeps its own edge space", () => {
    expect(
      nativeItems(row({ gap: 12 }), [
        { id: "b", props: fixed(100, { gapBefore: 20 }) }
      ]).styles[0].marginInlineStart
    ).toBe(20);
  });

  it("T03/T20 rejects distributed spacing and duplicated ownership", () => {
    const items = [
      { id: "a", props: fixed(100, { gapAfter: 20 }) },
      { id: "b", props: fixed(100, { gapBefore: 20 }) }
    ];
    expect(() => nativeItems(row(), items)).toThrow(
      "E_DUPLICATE_BOUNDARY_SPACE"
    );
    expect(() =>
      nativeItems(row({ justify: "between" }), items.slice(0, 1))
    ).toThrow("E_MIXED_SPACE_DISTRIBUTION");
  });

  it("validates break conflicts before reporting unsupported capabilities", () => {
    expect(() =>
      nativeItems(row(), [
        { id: "a", props: fixed(100, { breakBefore: "force" }) }
      ])
    ).toThrow("E_FORCE_WITHOUT_WRAP");
    expect(() =>
      nativeItems(row({ wrap: true }), [
        { id: "a", props: fixed(100, { breakBefore: "force" }) }
      ])
    ).toThrow("E_INVALID_BREAK_EDGE");
    const items = [
      { id: "a", props: fixed(100, { breakAfter: "force" }) },
      { id: "b", props: fixed(100, { breakBefore: "never" }) }
    ];
    expect(() => nativeItems(row({ wrap: true }), items)).toThrow(
      "E_DUPLICATE_BREAK"
    );
    expect(() =>
      nativeItems(row({ wrap: true }), [
        items[0],
        { id: "b", props: fixed(100, { gapBefore: 20 }) }
      ])
    ).toThrow("E_FORCE_WITH_EXPLICIT_SPACE");
  });

  it("rejects precision-only wrap, stretch competition, bounded spaces and shrink", () => {
    const a = { id: "a", props: fixed() };
    expect(() =>
      nativeItems(row({ wrap: true }), [
        a,
        { id: "b", props: fixed(100, { gapBefore: 20 }) }
      ])
    ).toThrow("E_LAYOUT_CAPABILITY");
    expect(() =>
      nativeItems(row(), [
        a,
        { id: "b", props: { width: "stretch", gapBefore: "stretch" } }
      ])
    ).toThrow("E_LAYOUT_CAPABILITY");
    expect(() =>
      nativeItems(row(), [
        a,
        {
          id: "b",
          props: fixed(100, { gapBefore: { size: "stretch", maxSize: 80 } })
        }
      ])
    ).toThrow("E_LAYOUT_CAPABILITY");
    expect(() =>
      nativeItems(row(), [
        a,
        { id: "b", props: fixed(100, { breakBefore: "never" }) }
      ])
    ).toThrow("E_LAYOUT_CAPABILITY");
    expect(() =>
      nativeItems(row(), [
        { id: "a", props: { width: 200, shrink: true } },
        { id: "b", props: { width: 100, shrink: true } }
      ])
    ).toThrow("E_LAYOUT_CAPABILITY");
  });

  it("keeps hugging and percentage sizes unless an item opts into shrink", () => {
    const hugging = nativeItems(row(), [
      { id: "a", props: {} },
      { id: "b", props: { width: "25%", gapBefore: "stretch" } },
      { id: "c", props: {} }
    ]);
    expect(hugging.styles.map((style) => style.flexShrink)).toEqual([0, 0, 0]);
    const yielding = nativeItems(row(), [
      { id: "a", props: {} },
      { id: "b", props: { shrink: true } }
    ]);
    expect(yielding.styles.map((style) => style.flexShrink)).toEqual([0, 1]);
  });

  it("normalizes fractional weights without leaving CSS free space unused", () => {
    const result = nativeItems(row(), [
      { id: "a", props: { width: { mode: "stretch", weight: 0.2 } } },
      { id: "b", props: { width: { mode: "stretch", weight: 0.4 } } }
    ]);
    expect(
      Number(result.styles[1].flexGrow) / Number(result.styles[0].flexGrow)
    ).toBeCloseTo(2);
    expect(Number(result.styles[0].flexGrow)).toBeGreaterThanOrEqual(1);
  });

  it("keeps absolute elements out of the flow model", () => {
    expect(
      normalizeRelations(row(), [
        { id: "overlay", props: { position: "absolute", width: 100 } }
      ]).flow
    ).toEqual([]);
  });

  it("preserves diagnostic codes and locations", () => {
    try {
      nativeItems(row(), [{ id: "a" }, { id: "a" }]);
      throw new Error("expected a layout error");
    } catch (error) {
      expect(error).toBeInstanceOf(LayoutError);
      expect((error as LayoutError).diagnostic).toMatchObject({
        code: "E_UNSUPPORTED_DOM_CHILD",
        itemId: "a"
      });
    }
  });
});
