import { replacePseudoSelectors } from "@/transform-keys/simple-pseudo-selectors";
import { removeMergeSymbol, mergeKeyInfo } from "@/transform-keys/merge-key";
import { mergeToComma, mergeToSpace } from "@/transform-values/merge-values";
import { simplyImportant } from "@/transform-values/simply-important";
import type { StyleRule } from "@vanilla-extract/css";
import type {
  CSSRule,
  CSSRuleKey,
  CSSRuleValue,
  VanillaStyleRuleValue
} from "@/types/style-rule";

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
    const { isMergeToComma, isMergeToSpace, isMergeSymbol } = mergeKeyInfo(key);

    const transformedValue =
      typeof value === "object"
        ? Array.isArray(value)
          ? transformArrayValue(value, isMergeToComma, isMergeToSpace)
          : transformStyle(value as CSSRule)
        : transformCommonValue(value);
    const transformedKey = replacePseudoSelectors(
      isMergeSymbol ? removeMergeSymbol(key) : key
    );
    result[transformedKey] = transformedValue as VanillaStyleRuleValue;
  }
  return result as StyleRule;
}

// == Utils ====================================================================
function transformArrayValue(
  value: CSSRuleValue,
  isMergeToComma: boolean,
  isMergeToSpace: boolean
): CSSRuleValue {
  const transformed = isMergeToComma
    ? mergeToComma(value as string[])
    : isMergeToSpace
    ? mergeToSpace(value as string[])
    : value;

  return Array.isArray(transformed)
    ? // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore: error TS2590: Expression produces a union type that is too complex to represent
      (transformed.map(transformCommonValue) as CSSRuleValue)
    : transformed;
}

function transformCommonValue(value: CSSRuleValue) {
  return typeof value === "string" ? simplyImportant(value) : value;
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("transform", () => {
    it("Fallback style", () => {
      expect(
        transformStyle({
          overflow: ["auto", "overlay"]
        })
      ).toStrictEqual({
        overflow: ["auto", "overlay"]
      } satisfies StyleRule);
    });

    it("Merge Values", () => {
      expect(
        transformStyle({
          boxShadow$: ["inset 0 0 10px #555", "0 0 20px black"],
          transform_: ["scale(2)", "rotate(15deg)"]
        })
      ).toStrictEqual({
        boxShadow: "inset 0 0 10px #555, 0 0 20px black",
        transform: "scale(2) rotate(15deg)"
      } satisfies StyleRule);

      expect(
        transformStyle({
          transform_: [
            // Apply to all
            "scale(2)",

            //  Fallback style
            ["rotate(28.64deg)", "rotate(0.5rad)"]
          ]
        })
      ).toStrictEqual({
        transform: ["scale(2) rotate(28.64deg)", "scale(2) rotate(0.5rad)"]
      } satisfies StyleRule);
    });

    it("Simply Important", () => {
      expect(
        transformStyle({
          color: "red!"
        })
      ).toStrictEqual({
        color: "red !important"
      } satisfies StyleRule);

      expect(
        transformStyle({
          overflow: ["auto !", "overlay"]
        })
      ).toStrictEqual({
        overflow: ["auto !important", "overlay"]
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
