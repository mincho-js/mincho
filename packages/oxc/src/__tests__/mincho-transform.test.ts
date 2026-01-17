import { describe, it, expect } from "vitest";
import { minchoTransform } from "../mincho-transform.js";

function assertHasSources(
  map: unknown
): asserts map is { sources: unknown[] | readonly unknown[] } {
  expect(map).toBeDefined();
  expect(typeof map).toBe("object");
  expect(map).not.toBeNull();
  expect("sources" in (map as Record<string, unknown>)).toBe(true);
}

describe("minchoTransform", () => {
  it("should transform styled() calls", () => {
    const code = `
      import { styled } from "@mincho-js/react";
      const Button = styled("button", { base: { color: "red" } });
    `;

    const result = minchoTransform(code, {
      filename: "test.tsx",
      sourceRoot: process.cwd(),
      extractCSS: false
    });

    expect(result.code).toContain("$$styled");
    expect(result.code).toContain("rules");
    expect(result.code).toContain("@__PURE__");
  });

  it("should extract style() calls to CSS modules", () => {
    const code = `
      import { style } from "@mincho-js/css";
      const red = style({ color: "red" });
    `;

    const result = minchoTransform(code, {
      filename: "test.ts",
      sourceRoot: process.cwd(),
      extractCSS: true
    });

    expect(result.cssExtractions.length).toBeGreaterThan(0);
    expect(result.code).toContain("import");
    expect(result.code).toContain("extracted_");
  });

  it("should handle mincho-ignore comments", () => {
    const code = `
      import { style } from "@mincho-js/css";
      const red = /* mincho-ignore */ style({ color: "red" });
    `;

    const result = minchoTransform(code, {
      filename: "test.ts",
      sourceRoot: process.cwd(),
      extractCSS: true
    });

    // Should not extract when mincho-ignore is present
    expect(result.cssExtractions.length).toBe(0);
  });

  it("should transform multiple styled() calls", () => {
    const code = `
      import { styled } from "@mincho-js/react";
      const Button = styled("button", { base: { color: "red" } });
      const Input = styled("input", { base: { border: "1px solid black" } });
    `;

    const result = minchoTransform(code, {
      filename: "test.tsx",
      sourceRoot: process.cwd(),
      extractCSS: false
    });

    // Count occurrences of $$styled (transformed calls)
    const matches = result.code.match(/\$\$styled/g);
    // Should have at least 2 transformed calls
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });

  it("should generate unique CSS file names", () => {
    const code1 = `
      import { style } from "@mincho-js/css";
      const red = style({ color: "red" });
    `;

    const code2 = `
      import { style } from "@mincho-js/css";
      const blue = style({ color: "blue" });
    `;

    const result1 = minchoTransform(code1, {
      filename: "test1.ts",
      sourceRoot: process.cwd(),
      extractCSS: true
    });

    const result2 = minchoTransform(code2, {
      filename: "test2.ts",
      sourceRoot: process.cwd(),
      extractCSS: true
    });

    // Different code should generate different CSS file hashes
    if (
      result1.cssExtractions.length > 0 &&
      result2.cssExtractions.length > 0
    ) {
      expect(result1.cssExtractions[0].id).not.toBe(
        result2.cssExtractions[0].id
      );
    }
  });

  it("should handle empty code", () => {
    const code = "";

    const result = minchoTransform(code, {
      filename: "test.ts",
      sourceRoot: process.cwd(),
      extractCSS: true
    });

    expect(result.code).toBe("");
    expect(result.cssExtractions.length).toBe(0);
  });

  it("should preserve source map information", () => {
    const code = `
      import { styled } from "@mincho-js/react";
      const Button = styled("button", { base: { color: "red" } });
    `;

    const result = minchoTransform(code, {
      filename: "test.tsx",
      sourceRoot: process.cwd(),
      extractCSS: false
    });

    assertHasSources(result.map);
    expect(result.map.sources).toBeDefined();
  });
});
