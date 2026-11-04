import { describe, expect, it } from "vitest";
import { getSquircleStyle } from "./styles.js";
import { getMaskAsset } from "./mask-cache.js";

describe("fixed squircle declarations", () => {
  it("uses the same effective geometry for CSS and the path", () => {
    const options = { width: 200, height: 100, radius: 20, smoothing: 0.6 };
    const result = getSquircleStyle(options);
    expect(result).toMatchObject({
      width: 200,
      minWidth: 200,
      maxWidth: 200,
      height: 100,
      minHeight: 100,
      maxHeight: 100,
      boxSizing: "border-box",
      overflow: "hidden",
      borderRadius: 0,
      clipPath: `path("${getMaskAsset(options)!.path}")`
    });
    expect(result).not.toHaveProperty("maskImage");
  });

  it("uses native rounded clipping when no smoothed region fits", () => {
    expect(
      getSquircleStyle({ width: 30, height: 20, radius: 24 })
    ).toMatchObject({
      clipPath: "none",
      borderRadius: 10
    });
    expect(getSquircleStyle({ width: -1, height: 20 })).toMatchObject({
      width: 0,
      minWidth: 0,
      clipPath: "none",
      borderRadius: 0
    });
  });
});
