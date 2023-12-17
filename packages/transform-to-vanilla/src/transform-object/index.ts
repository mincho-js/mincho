import { simplyImportant } from "@/transform-values/simply-important";
import type { StyleRule } from "@vanilla-extract/css";
import type {
  CSSRule,
  CSSRuleKey,
  CSSRuleValue,
  StyleRuleValue
} from "@/types/style-rule";

// == Interface ================================================================
export function transformStyle(style: CSSRule) {
  const result: {
    // key in StyleRuleKey occur a error
    // Type '{}' is missing the following properties from type
    // '{ accentColor: StyleRuleValue; alignContent: StyleRuleValue; alignItems: StyleRuleValue; alignSelf: StyleRuleValue; ... 904 more ...;
    //  vars: StyleRuleValue; }': accentColor, alignContent, alignItems, alignSelf, and 905 more.ts(2740)
    [key in string]: StyleRuleValue;
  } = {};

  for (const [key, value] of Object.entries(style) as [
    CSSRuleKey,
    CSSRuleValue
  ][]) {
    if (typeof value === "string") {
      result[key] = simplyImportant(value);
      continue;
    }
    result[key] = value;
  }
  return result as StyleRule;
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("transform", () => {
    it("Simply Important", () => {
      expect(
        transformStyle({
          color: "red!"
        })
      ).toStrictEqual({
        color: "red !important"
      } satisfies StyleRule);
    });
  });
}
