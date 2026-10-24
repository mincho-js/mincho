import { describe, it, expect } from "vitest";
import {
  measureRuntimeCandidate,
  preferRuntimeCandidate
} from "./bundleSize.js";
const config = {
  defaultClassName: "base",
  variantClassNames: {
    size: {
      small: "small",
      large: "large"
    }
  },
  defaultVariants: {
    size: "small"
  },
  compoundVariants: []
};
const recipe = `import {createCompiledClassRuntimeFn} from '@mincho-js/css/rules/createClassRuntimeFn'; export const button=createCompiledClassRuntimeFn(${JSON.stringify(config)});`;
describe("bundle-size safety and costs", () => {
  it("charges actual compact helper dependencies and preserves ties", async () => {
    const after = recipe
      .replaceAll("createCompiledClassRuntimeFn", "createCompactClassRuntimeFn")
      .replace("/createClassRuntimeFn", "/createCompactRuntimeFn");
    const result = await preferRuntimeCandidate(
      recipe,
      after,
      process.cwd() + "/fixture.ts"
    );
    expect(result.applied).toBe(true);
    expect(result.candidate.brotli).toBeLessThan(result.original.brotli);
    expect(
      (
        await preferRuntimeCandidate(
          recipe,
          recipe,
          process.cwd() + "/fixture.ts"
        )
      ).applied
    ).toBe(false);
    expect(
      (await measureRuntimeCandidate(after, process.cwd() + "/fixture.ts")).raw
    ).toBeGreaterThan(after.length);
  });
});
