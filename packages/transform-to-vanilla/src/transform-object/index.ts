import { replacePseudoSelectors } from "@/transform-keys/simple-pseudo-selectors";
import {
  isSelectorskey,
  isComplexKey,
  isSimpleSelectorKey
} from "@/transform-keys/complex-selectors";
import {
  isVarsKey,
  isCSSVarKey,
  isPureCSSVarKey,
  replaceCSSVarKey
} from "@/transform-keys/css-var";
import { replaceCSSVar } from "@/transform-values/css-var";
import {
  isRuleKey,
  atRuleKeyInfo,
  anonymousKeyInfo
} from "@/transform-keys/at-rules";
import { removeMergeSymbol, mergeKeyInfo } from "@/transform-keys/merge-key";
import { mergeToComma, mergeToSpace } from "@/transform-values/merge-values";
import { simplyImportant } from "@/transform-values/simply-important";
import { keyframes, fontFace } from "@vanilla-extract/css";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import type { StyleRule } from "@vanilla-extract/css";
import type {
  CSSRule,
  CSSRuleKey,
  CSSRuleValue,
  VanillaStyleRuleValue
} from "@/types/style-rule";

// == Interface ================================================================
type StyleResult = {
  // key in StyleRuleKey occur a error
  // Type '{}' is missing the following properties from type
  // '{ accentColor: StyleRuleValue; alignContent: StyleRuleValue; alignItems: StyleRuleValue; alignSelf: StyleRuleValue; ... 904 more ...;
  //  vars: StyleRuleValue; }': accentColor, alignContent, alignItems, alignSelf, and 905 more.ts(2740)
  [key in string]: VanillaStyleRuleValue;
};
type CSSRuleExistValue = Exclude<CSSRuleValue, undefined>;

export function transformStyle(style: CSSRule) {
  const result: StyleResult = {};

  for (const [key, value] of Object.entries(style) as [
    CSSRuleKey,
    CSSRuleExistValue
  ][]) {
    if (isSelectorskey(key)) {
      for (const [selector, style] of Object.entries(value)) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore: error TS2345
        transformComplexStyle(result, selector, style);
      }
    } else if (isComplexKey(key)) {
      transformComplexStyle(result, key, value);
    } else if (isSimpleSelectorKey(key)) {
      transformComplexStyle(result, `&${key}`, value);
    } else if (isVarsKey(key)) {
      for (const [varKey, varValue] of Object.entries(value)) {
        const transformedVarKey = isCSSVarKey(varKey)
          ? replaceCSSVarKey(varKey)
          : varKey;
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore: error TS2345
        transformCSSVarStyle(result, transformedVarKey, varValue);
      }
    } else if (isCSSVarKey(key)) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore: error TS2345
      transformCSSVarStyle(result, replaceCSSVarKey(key), value);
    } else if (isPureCSSVarKey(key)) {
      transformCSSVarStyle(result, key, value);
    } else if (isRuleKey(key)) {
      transformRuleStyle(result, key, value);
    } else {
      transformValueStyle(result, key, value);
    }
  }
  return result as StyleRule;
}

function insertResultValue(
  result: Record<string, unknown>,
  accessKey: string,
  key: string,
  value: unknown
) {
  if (result[accessKey] === undefined) {
    result[accessKey] = {};
  }
  (result[accessKey] as Record<string, unknown>)[key] = value;
}

function transformComplexStyle(
  result: StyleResult,
  key: CSSRuleKey,
  value: CSSRuleExistValue
) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: error TS2590: Expression produces a union type that is too complex to represent
  insertResultValue(result, "selectors", key, transformStyle(value as CSSRule));
}

function transformCSSVarStyle(
  result: StyleResult,
  key: CSSRuleKey,
  value: CSSRuleExistValue
) {
  insertResultValue(result, "vars", key, value);
}

function transformRuleStyle(
  result: StyleResult,
  key: CSSRuleKey,
  value: CSSRuleExistValue
) {
  const { isToplevelRules, atRuleKey, atRuleNestedKey } = atRuleKeyInfo(key);
  const transformed = transformStyle(value as CSSRule);
  const ruleValue = isToplevelRules
    ? {
        [atRuleNestedKey]: transformed
      }
    : transformed;
  result[atRuleKey] = {
    ...(result[atRuleKey] ?? {}),
    ...ruleValue
  };
}

function transformValueStyle(
  result: StyleResult,
  key: CSSRuleKey,
  value: CSSRuleExistValue
) {
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

// == Utils ====================================================================
function transformArrayValue<T>(
  key: string,
  values: T[],
  isMergeToComma: boolean,
  isMergeToSpace: boolean
): CSSRuleValue {
  // Make to string
  const resolvedAnonymous = values.map((value) => {
    if (typeof value === "object") {
      return Array.isArray(value)
        ? value.map((fallbackValue) =>
            transformArrayAnonymousValue(key, fallbackValue)
          )
        : transformArrayAnonymousValue(key, value as CSSRuleValue);
    }
    return value;
  });

  const transformed = isMergeToComma
    ? mergeToComma(resolvedAnonymous as string[])
    : isMergeToSpace
    ? mergeToSpace(resolvedAnonymous as string[])
    : resolvedAnonymous;

  return Array.isArray(transformed)
    ? // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore: error TS2590: Expression produces a union type that is too complex to represent
      (transformed.map(transformCommonValue) as CSSRuleValue)
    : transformed;
}

function transformArrayAnonymousValue(key: string, value: CSSRuleValue) {
  return typeof value === "object" ? transformAnonymous(key, value) : value;
}

function transformObjectValue(key: string, value: CSSRuleValue) {
  const transformed = transformAnonymous(key, value);
  return typeof transformed === "string"
    ? transformed
    : transformStyle(value as CSSRule);
}

function transformAnonymous(key: string, value: CSSRuleValue) {
  const { isAnimationName, isFontFamily } = anonymousKeyInfo(key);

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
  return typeof value === "string"
    ? simplyImportant(replaceCSSVar(value))
    : value;
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  setFileScope("test");
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

    it("CSS variables", () => {
      expect(
        transformStyle({
          $myCssVariable1: "red",
          "--my-css-variable2": "green",
          vars: {
            $myCssVariable3: "blue",
            "--my-css-variable4": "black"
          }
        })
      ).toStrictEqual({
        vars: {
          "--my-css-variable1": "red",
          "--my-css-variable2": "green",
          "--my-css-variable3": "blue",
          "--my-css-variable4": "black"
        }
      } satisfies StyleRule);

      expect(
        transformStyle({
          color: "$myCssVariable",
          _hover: {
            padding: "calc($myCssVariable2 - 1px)",
            margin: "calc(var(--my-css-variable3) - 1px)"
          }
        })
      ).toStrictEqual({
        color: "var(--my-css-variable)",
        ":hover": {
          padding: "calc(var(--my-css-variable2) - 1px)",
          margin: "calc(var(--my-css-variable3) - 1px)"
        }
      } satisfies StyleRule);

      expect(
        transformStyle({
          color: "$myCssVariable(red)",
          _hover: {
            // padding: "calc($myCssVariable2($my-css-variable3(5px)) - 1px)",
            margin: "calc(var(--my-css-variable4) - 1px)"
          }
        })
      ).toStrictEqual({
        color: "var(--my-css-variable, red)",
        ":hover": {
          // padding:
          //   "calc(var(--my-css-variable2, var(--my-css-variable3, 5px)) - 1px)",
          margin: "calc(var(--my-css-variable4) - 1px)"
        }
      } satisfies StyleRule);
    });

    it("Simple selector", () => {
      expect(
        transformStyle({
          ":hover:active": {
            color: "red"
          },
          "[disabled]": {
            color: "green"
          },
          '[href^="https://"][href$=".org"]': {
            color: "blue"
          }
        })
      ).toStrictEqual({
        selectors: {
          "&:hover:active": {
            color: "red"
          },
          "&[disabled]": {
            color: "green"
          },
          '&[href^="https://"][href$=".org"]': {
            color: "blue"
          }
        }
      } satisfies StyleRule);
    });

    it("Complex Selectors", () => {
      expect(
        transformStyle({
          "&:hover:not(:active)": {
            border: "2px solid aquamarine"
          },
          "nav li > &": {
            textDecoration: "underline"
          },
          selectors: {
            "a:nth-of-type(2) &": {
              opacity: 1
            }
          }
        })
      ).toStrictEqual({
        selectors: {
          "&:hover:not(:active)": {
            border: "2px solid aquamarine"
          },
          "nav li > &": {
            textDecoration: "underline"
          },
          "a:nth-of-type(2) &": {
            opacity: 1
          }
        }
      } satisfies StyleRule);
    });

    it("At Rules", () => {
      expect(
        transformStyle({
          // Top level
          "@media print": {
            padding: 5
          },

          // Nested
          "@media": {
            "screen and (min-width: 768px)": {
              padding: 10
            },
            "(prefers-reduced-motion)": {
              transitionProperty: "color"
            }
          },

          // Another query
          "@supports (display: grid)": {
            display: "grid"
          }
        })
      ).toStrictEqual({
        "@media": {
          print: {
            padding: 5
          },
          "screen and (min-width: 768px)": {
            padding: 10
          },
          "(prefers-reduced-motion)": {
            transitionProperty: "color"
          }
        },

        "@supports": {
          "(display: grid)": {
            display: "grid"
          }
        }
      } satisfies StyleRule);
    });

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

      const anonymous = transformStyle({
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
          fontWeight: 900,
          src$: [
            "local('Pretendard Regular')",
            "url(../../../packages/pretendard/dist/web/static/woff2/Pretendard-Regular.woff2) format('woff2')",
            "url(../../../packages/pretendard/dist/web/static/woff/Pretendard-Regular.woff) format('woff')"
          ]
        }
      });
      expect(anonymous.animationName).toBeTypeOf("string");
      expect(anonymous.fontFamily).toBeTypeOf("string");
    });
  });
}
