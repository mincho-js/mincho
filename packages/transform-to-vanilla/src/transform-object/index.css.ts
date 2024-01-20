import { replacePseudoSelectors } from "@/transform-keys/simple-pseudo-selectors";
import { removeMergeSymbol, mergeKeyInfo } from "@/transform-keys/merge-key";
import { mergeToComma, mergeToSpace } from "@/transform-values/merge-values";
import { simplyImportant } from "@/transform-values/simply-important";
import { anonymouseKeyInfo } from "@/transform-keys/anonymous-at-rules";
import { keyframes, fontFace } from "@vanilla-extract/css";
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
    console.log(key);
    console.log(value);
    const { isMergeToComma, isMergeToSpace, isMergeSymbol } = mergeKeyInfo(key);

    const transformedValue =
      typeof value === "object"
        ? Array.isArray(value)
          ? transformArrayValue(key, value, isMergeToComma, isMergeToSpace)
          : transformObjectValue(key, value)
        : transformCommonValue(value);
    const transformedKey = replacePseudoSelectors(
      isMergeSymbol ? removeMergeSymbol(key) : key
    );
    result[transformedKey] = transformedValue as VanillaStyleRuleValue;
  }
  return result as StyleRule;
}

// == Utils ====================================================================
function transformArrayValue<T>(
  key: string,
  values: T[],
  isMergeToComma: boolean,
  isMergeToSpace: boolean
): CSSRuleValue {
  // Make to string
  const resolvedAnonymouse = values.map((value) => {
    if (typeof value === "object") {
      return Array.isArray(value)
        ? value.map((fallbackValue) => transformAnonymouse(key, fallbackValue))
        : transformAnonymouse(key, value as CSSRuleValue);
    }
    return value;
  });

  const transformed = isMergeToComma
    ? mergeToComma(resolvedAnonymouse as string[])
    : isMergeToSpace
    ? mergeToSpace(resolvedAnonymouse as string[])
    : resolvedAnonymouse;

  return Array.isArray(transformed)
    ? // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore: error TS2590: Expression produces a union type that is too complex to represent
      (transformed.map(transformCommonValue) as CSSRuleValue)
    : transformed;
}

function transformObjectValue(key: string, value: CSSRuleValue) {
  const { isAnimationName, isFontFamily } = anonymouseKeyInfo(key);
  if (isAnimationName) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: error TS2590: Expression produces a union type that is too complex to represent
    return keyframes(value);
  }
  if (isFontFamily) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: error TS2590: Expression produces a union type that is too complex to represent
    return fontFace(value);
  }
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: error TS2590: Expression produces a union type that is too complex to represent
  return transformStyle(value);
}

function transformAnonymouse(key: string, value: CSSRuleValue) {
  if (value === "string") return value;

  const { isAnimationName, isFontFamily } = anonymouseKeyInfo(key);
  console.log(key);
  console.log(value);
  console.log(anonymouseKeyInfo(key));
  console.log("");
  if (isAnimationName) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: error TS2590: Expression produces a union type that is too complex to represent
    return keyframes(value);
  }
  if (isFontFamily) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: error TS2590: Expression produces a union type that is too complex to represent
    return fontFace(value);
  }
  return value;
}

function transformCommonValue(value: CSSRuleValue) {
  return typeof value === "string" ? simplyImportant(value) : value;
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("transform", () => {
    // it("Fallback style", () => {
    //   expect(
    //     transformStyle({
    //       overflow: ["auto", "overlay"]
    //     })
    //   ).toStrictEqual({
    //     overflow: ["auto", "overlay"]
    //   } satisfies StyleRule);
    // });

    // it("Merge Values", () => {
    //   expect(
    //     transformStyle({
    //       boxShadow$: ["inset 0 0 10px #555", "0 0 20px black"],
    //       transform_: ["scale(2)", "rotate(15deg)"]
    //     })
    //   ).toStrictEqual({
    //     boxShadow: "inset 0 0 10px #555, 0 0 20px black",
    //     transform: "scale(2) rotate(15deg)"
    //   } satisfies StyleRule);

    //   expect(
    //     transformStyle({
    //       transform_: [
    //         // Apply to all
    //         "scale(2)",

    //         //  Fallback style
    //         ["rotate(28.64deg)", "rotate(0.5rad)"]
    //       ]
    //     })
    //   ).toStrictEqual({
    //     transform: ["scale(2) rotate(28.64deg)", "scale(2) rotate(0.5rad)"]
    //   } satisfies StyleRule);
    // });

    // it("Simply Important", () => {
    //   expect(
    //     transformStyle({
    //       color: "red!"
    //     })
    //   ).toStrictEqual({
    //     color: "red !important"
    //   } satisfies StyleRule);

    //   expect(
    //     transformStyle({
    //       overflow: ["auto !", "overlay"]
    //     })
    //   ).toStrictEqual({
    //     overflow: ["auto !important", "overlay"]
    //   } satisfies StyleRule);
    // });

    // it("Simple Psudo selectors", () => {
    //   expect(
    //     transformStyle({
    //       _hover: {
    //         color: "red!"
    //       },
    //       __MozSelection: {
    //         background: "blue"
    //       }
    //     })
    //   ).toStrictEqual({
    //     ":hover": {
    //       color: "red !important"
    //     },
    //     "::-moz-selection": {
    //       background: "blue"
    //     }
    //   } satisfies StyleRule);
    // });

    it("Anonymous AtRules", () => {
      expect(
        transformStyle({
          animationName: "none",
          fontFamily: "sans-serif"
        })
      ).toStrictEqual({
        animationName: "none",
        fontFamily: "sans-serif"
      } satisfies StyleRule);

      expect(
        transformStyle({
          animationName: {
            from: {
              opacity: 0
            },
            "50%": {
              opacity: 0.3
            },
            to: {
              opacity: 1
            }
          },
          fontFamily: {
            fontFamily: "Pretendard",
            fontWeight: 900,
            src$: [
              "local('Pretendard Regular')",
              "url(../../../packages/pretendard/dist/web/static/woff2/Pretendard-Regular.woff2) format('woff2')",
              "url(../../../packages/pretendard/dist/web/static/woff/Pretendard-Regular.woff) format('woff')"
            ]
          }
        })
      ).toStrictEqual({
        animationName: "none",
        fontFamily: "sans-serif"
      } satisfies StyleRule);
    });
  });
}
