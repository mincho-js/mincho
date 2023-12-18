import { simplyImportant } from "@/transform-values/simply-important";
import type { StyleRule } from "@vanilla-extract/css";
import type {
  CSSRule,
  CSSRuleKey,
  CSSRuleValue,
  VanillaStyleRuleValue
} from "@/types/style-rule";
import { replacePseudoSelectors } from "@/transform-keys/simple-pseudo-selectors";

// == Interface ================================================================
export function transformStyle(style: CSSRule) {
  const result: {
    // key in StyleRuleKey occur a error
    // Type '{}' is missing the following properties from type
    // '{ accentColor: StyleRuleValue; alignContent: StyleRuleValue; alignItems: StyleRuleValue; alignSelf: StyleRuleValue; ... 904 more ...;
    //  vars: StyleRuleValue; }': accentColor, alignContent, alignItems, alignSelf, and 905 more.ts(2740)
    [key in string]: VanillaStyleRuleValue;
  } = {};

  for (const [key, value] of Object.entries(style) as [
    CSSRuleKey,
    CSSRuleValue
  ][]) {
    const transformedValue =
      typeof value === "object"
        ? transformStyle(value as CSSRule) // TODO: Array
        : typeof value === "string"
        ? simplyImportant(value)
        : value;
    const transformedKey = replacePseudoSelectors(key);
    result[transformedKey] = transformedValue as VanillaStyleRuleValue;
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

    it("Simple Psudo", () => {
      expect(
        transformStyle({
          _hover: {
            color: "red!"
          },
          __MozSelection: {
            background: "blue"
          }
        })
      ).toStrictEqual({
        ":hover": {
          color: "red !important"
        },
        "::-moz-selection": {
          background: "blue"
        }
      } satisfies StyleRule);
    });
  });
}
