import { describe, expect, it } from "vitest";
import { isPathInsideRoot } from "./staticCssEval.js";
import {
  internalIsStaticCssEvalPathInsideRoot,
  internalNormalizeStaticCssEvalPathSyntax,
  normalizeStaticCssEvalFileId
} from "./staticCssEvalUtils.js";

describe("shared static CSS path boundaries", () => {
  it.each([
    ["/", "/project/styles.ts", true],
    ["///", "/project/styles.ts", true],
    ["/project/", "/project/styles.ts", true],
    ["/project", "/projected/styles.ts", false],
    ["C:\\project", "C:\\project\\styles.ts", true],
    ["/project", "ssr:/@fs/project/styles.ts?used", true]
  ])("uses the same boundary for %s and %s", (root, file, expected) => {
    expect(internalIsStaticCssEvalPathInsideRoot(root, file)).toBe(expected);
    expect(
      isPathInsideRoot(root, file, internalNormalizeStaticCssEvalPathSyntax)
    ).toBe(expected);
  });

  it("preserves a missing absolute file under the filesystem root", () => {
    expect(normalizeStaticCssEvalFileId("/mincho-missing/styles.ts", "/")).toBe(
      "/mincho-missing/styles.ts"
    );
  });
});
