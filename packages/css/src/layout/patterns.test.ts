import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mockAdapter,
  removeAdapter,
  setAdapter
} from "@vanilla-extract/css/adapter";
import { endFileScope, setFileScope } from "@vanilla-extract/css/fileScope";
import { box, compileLayoutClass, hstack, item, stackLayout } from "./index.js";
import { resolveLayout } from "./layout.js";

const output: unknown[] = [];
beforeEach(() => {
  output.length = 0;
  setAdapter({ ...mockAdapter, appendCss: (rule) => output.push(rule) });
  setFileScope("src/toolbar.css.ts", "layout-test");
});
afterEach(() => {
  endFileScope();
  removeAdapter();
});

describe("extracted className patterns", () => {
  it("returns real Mincho classes and emits px declarations", () => {
    expect(hstack({ width: 400, gap: 16, padding: 24 })).toEqual(
      expect.any(String)
    );
    expect(output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: expect.objectContaining({
            display: "flex",
            width: 400,
            columnGap: 16,
            padding: 24
          })
        })
      ])
    );
    box({ width: 100 });
    expect(output).toHaveLength(2);
  });

  it("compiles a static topology and keeps its boundary adjustments", () => {
    const result = stackLayout({ axis: "horizontal", width: 400, gap: 12 }, [
      { id: "a", props: { width: 100, gapAfter: 20 } },
      { id: "b", props: { width: 100 } }
    ]);
    expect(Object.keys(result.itemClassNames)).toEqual(["a", "b"]);
    expect(output).toHaveLength(3);
    expect(output[1]).toMatchObject({ rule: { marginInlineEnd: 8 } });
  });

  it("requires complete sibling information before emitting relations", () => {
    expect(() => item({ gapBefore: 20 }, { axis: "horizontal" })).toThrow(
      "E_LAYOUT_CAPABILITY"
    );
    expect(() =>
      stackLayout({ axis: "horizontal" }, [
        { id: "a", props: { gapAfter: 20 } },
        { id: "b", props: { gapBefore: 20 } }
      ])
    ).toThrow("E_DUPLICATE_BOUNDARY_SPACE");
    expect(output).toEqual([]);
  });

  it("reuses normalized compiled declarations within each file evaluation", () => {
    const first = compileLayoutClass("HStack", { width: 400, gap: 8 });
    expect(
      compileLayoutClass("Stack", {
        gap: 8,
        width: 400,
        axis: "horizontal",
        padding: 0
      })
    ).toBe(first);
    const second = compileLayoutClass("Item", { width: 80 });
    expect(
      compileLayoutClass("Item", { width: 80, height: "hug-contents" })
    ).toBe(second);
    expect(output).toHaveLength(2);
    endFileScope();
    setFileScope("src/toolbar.css.ts", "layout-test");
    compileLayoutClass("Item", { width: 80 });
    expect(output).toHaveLength(3);
    endFileScope();
    setFileScope("src/other.css.ts", "layout-test");
    expect(compileLayoutClass("Item", { width: 80 })).not.toBe(second);
    expect(output).toHaveLength(4);
  });

  it("uses the same fractional stretch factors in standalone and compiled items", () => {
    item(
      { width: { mode: "stretch", weight: 0.2 } },
      { axis: "horizontal", width: 600 }
    );
    const { style } = resolveLayout("Item", {
      width: { mode: "stretch", weight: 0.2 }
    });
    expect(output[0]).toMatchObject({
      rule: { flexGrow: Number(style["--mincho-layout-grow-w"]) }
    });
  });

  it("compiles the React renderer's declarations into one attribute-scoped class", () => {
    const props = { width: "stretch", gapBefore: 20, shrink: true } as const;
    expect(compileLayoutClass("Item", props)).toEqual(expect.any(String));
    const { style } = resolveLayout("Item", props);
    const rule = (
      output[0] as {
        rule: { selectors: Record<string, Record<string, unknown>> };
      }
    ).rule.selectors["[data-mincho-layout]&"];
    expect(rule.vars).toEqual(
      Object.fromEntries(
        Object.entries(style)
          .filter(([key]) => key.startsWith("--"))
          .map(([key, value]) => [key, String(value)])
      )
    );
    expect(rule).toMatchObject({ position: "static", padding: 0 });
    expect(() => compileLayoutClass("Box", { gapBefore: 20 })).toThrow(
      "E_LAYOUT_CAPABILITY"
    );
  });
});
