import { describe, expect, it } from "vitest";
import {
  isShareableCss,
  planCssChunkSharing,
  resolveCssChunkSharingOptions
} from "./cssChunkSharing.js";

describe("CSS chunk sharing", () => {
  const modules = new Map(
    ["base", "extra", "a", "b", "c"].map((id) => [
      id,
      { bytes: 100, shareable: true }
    ])
  );

  it("shares only a common ordered prefix and picks the largest saving", () => {
    expect(
      planCssChunkSharing(
        [
          { id: "a", modules: ["base", "extra", "a"] },
          { id: "b", modules: ["base", "extra", "b"] }
        ],
        modules,
        { minBoundaries: 2, minBytes: 0 }
      )
    ).toMatchObject([
      { modules: ["base", "extra"], boundaries: ["a", "b"], savedBytes: 200 }
    ]);
  });

  it("requires every consumer to agree on the prefix", () => {
    expect(
      planCssChunkSharing(
        [
          { id: "a", modules: ["base", "extra", "a"] },
          { id: "b", modules: ["base", "extra", "b"] },
          { id: "c", modules: ["base", "c"] }
        ],
        modules,
        { minBoundaries: 2, minBytes: 0 }
      )
    ).toMatchObject([
      { modules: ["base"], boundaries: ["a", "b", "c"], savedBytes: 200 }
    ]);
    expect(
      planCssChunkSharing(
        [
          { id: "a", modules: ["base", "a"] },
          { id: "b", modules: ["base", "b"] },
          { id: "c", modules: ["c", "base"] }
        ],
        modules,
        { minBoundaries: 2, minBytes: 0 }
      )
    ).toEqual([]);
  });

  it("uses naming keys without changing module ownership or order", () => {
    const groups = ["/checkout-a", "/checkout-b"].map((root) => {
      const ids = ["base", "extra"].map((id) => `${root}/${id}.css`);
      const boundaries = ["a", "b"].map((id) => ({ id, modules: ids }));
      const inputs = new Map(
        ids.map((id) => [id, { bytes: 100, shareable: true }])
      );
      const options = { minBoundaries: 2, minBytes: 0 };
      const [group] = planCssChunkSharing(
        boundaries,
        inputs,
        options,
        (id) => id.slice(root.length + 1)
      );

      expect(group).toMatchObject({
        modules: ids,
        boundaries: ["a", "b"],
        savedBytes: 200
      });
      expect(
        planCssChunkSharing(boundaries, inputs, options)[0]!.name
      ).not.toBe(group!.name);

      return group!;
    });

    expect(groups[0]!.name).toBe(groups[1]!.name);
  });

  it("keeps unowned modules as ordering barriers and applies thresholds", () => {
    const boundaries = [
      { id: "a", modules: ["unknown", "base", "a"] },
      { id: "b", modules: ["unknown", "base", "b"] }
    ];

    expect(
      planCssChunkSharing(boundaries, modules, {
        minBoundaries: 2,
        minBytes: 0
      })
    ).toEqual([]);
    expect(resolveCssChunkSharingOptions(true)).toEqual({
      minBoundaries: 2,
      minBytes: 4096
    });
    expect(resolveCssChunkSharingOptions(false)).toBeUndefined();
    expect(() => resolveCssChunkSharingOptions({ minBoundaries: 1 })).toThrow();
    expect(() => resolveCssChunkSharingOptions({ minBytes: -1 })).toThrow();
  });

  it.each([
    '.local { color: red; content: "@import }"; }',
    "@media (width > 10px) { .local:hover { color: red; } }",
    "/* @layer ignored */ .a, .b.c { background: url('./image.png'); }",
    " \t\n\f\r@media\t(width > 10px) {\n.a,\f.b\r{ color: red; }\t}",
    String.raw`.a { content: "escaped \" } /*"; }`,
    String.raw`.a { content: 'escaped \' } /*'; }`,
    '.a { content: "continued\\\r\nstring"; }'
  ])("accepts class-owned CSS: %s", (source) => {
    expect(isShareableCss(source)).toBe(true);
  });

  it.each([
    "body { color: red; }",
    ":root { --x: red; }",
    "@layer a { .local { color: red; } }",
    "@property --x { syntax: '*'; inherits: false; }",
    "@font-face { font-family: x; }",
    "@keyframes a { to { opacity: 0; } }",
    '@import "./a.css"; .local { color: red; }',
    ".a .b { color: red; }",
    ".a { & .b { color: red; } }",
    ".a { color: red; } }",
    "\u00a0.a { color: red; }",
    ".a\u00a0 { color: red; }",
    ".a, \u00a0.b { color: red; }",
    "@media\u00a0screen { .a { color: red; } }",
    "\u000b.a { color: red; }",
    "\ufeff.a { color: red; }",
    '.a { content: "unterminated; }',
    ".a { content: 'unterminated; }",
    '.a { content: "raw\nnewline"; }',
    ".a { color: red; } /* unterminated"
  ])("rejects global or uncertain ownership: %s", (source) => {
    expect(isShareableCss(source)).toBe(false);
  });

  it("rejects long unterminated comments and escaped strings", () => {
    for (const source of [
      "/*" + "a/*".repeat(20_000),
      '"' + String.raw`\"`.repeat(20_000),
      "'" + String.raw`\'`.repeat(20_000)
    ])
      expect(isShareableCss(source)).toBe(false);
  });
});
