import { describe, expect, it } from "vitest";
import { createDefineRulesRuntime } from "./runtime.js";
import {
  setAdapter,
  removeAdapter,
  mockAdapter
} from "@vanilla-extract/css/adapter";
import { setFileScope, endFileScope } from "@vanilla-extract/css/fileScope";
import type { Adapter } from "@vanilla-extract/css";

describe("shortcuts inside condition blocks", () => {
  it("preserves configured underscore-prefixed property resolvers", () => {
    const { css } = createDefineRulesRuntime(
      {
        properties: {
          _spacing: ({ x }: { x: number }) => ({ marginLeft: x })
        },
        conditions: { hov: { selector: "&:hover" } }
      },
      { registerPreset: false }
    );
    expect(css.raw({ _spacing: { x: 2 } })).toEqual({ marginLeft: 2 });
    expect(css.raw({ _hov: { _spacing: { x: 4 } } })).toEqual({
      selectors: { "&:hover": { marginLeft: 4 } }
    });
  });

  it("expands the same declarations as property-level conditions", () => {
    const { css } = createDefineRulesRuntime(
      {
        properties: { paddingLeft: true, paddingRight: true },
        shortcuts: { px: ["paddingLeft", "paddingRight"] },
        conditions: { hov: { selector: "&:hover" } }
      } as const,
      { registerPreset: false }
    );
    expect(css.raw({ _hov: { px: 2 } })).toEqual({
      selectors: { "&:hover": { paddingLeft: 2, paddingRight: 2 } }
    });
    expect(css.raw({ _hov: { px: 2 } })).toEqual(css.raw({ px: { _hov: 2 } }));
  });

  it("emits separate atoms and keeps condition overrides in declaration order", () => {
    const rules: Parameters<Adapter["appendCss"]>[0][] = [];
    setAdapter({ ...mockAdapter, appendCss: (rule) => rules.push(rule) });
    setFileScope("shortcuts.css.ts", "test");
    try {
      const { css } = createDefineRulesRuntime(
        {
          properties: { paddingLeft: true, paddingRight: true },
          shortcuts: { px: ["paddingLeft", "paddingRight"] },
          conditions: {
            hov: { selector: "&:hover" },
            wide: { "@media": "(min-width: 600px)" }
          }
        } as const,
        { registerPreset: false }
      );
      css({ _hov: { px: 2, paddingLeft: 4 } });
      expect(rules).toHaveLength(2);
      expect(
        rules.map((rule) => (rule.type === "local" ? rule.rule : null))
      ).toEqual(
        expect.arrayContaining([
          { selectors: { "&:hover": { paddingLeft: 4 } } },
          { selectors: { "&:hover": { paddingRight: 2 } } }
        ])
      );
      expect(css.raw({ _wide: { _hov: { px: 2 } } })).toEqual(
        css.raw({ px: { _wide: { _hov: 2 } } })
      );
    } finally {
      endFileScope();
      removeAdapter();
    }
  });
});
