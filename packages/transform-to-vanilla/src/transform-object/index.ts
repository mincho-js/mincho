import {
  isSimplePseudoSelectorKey,
  replacePseudoSelectors
} from "@/transform-keys/simple-pseudo-selectors";
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

interface TransformContext {
  result: StyleResult;
  basedKey: string;
  parentSelector: string;
}
const initTransformContext: TransformContext = {
  result: {},
  basedKey: "",
  parentSelector: ""
};

export function transformStyle(
  style: CSSRule,
  context = structuredClone(initTransformContext)
) {
  for (const [key, value] of Object.entries(style) as [
    CSSRuleKey | "base",
    CSSRuleExistValue
  ][]) {
    if (isSelectorskey(key)) {
      for (const [selector, style] of Object.entries(value)) {
        transformComplexStyle(selector, style, context);
      }
    } else if (isComplexKey(key) || key === "base") {
      transformComplexStyle(key, value, context);
    } else if (isSimplePseudoSelectorKey(key)) {
      transformComplexStyle(`&${replacePseudoSelectors(key)}`, value, context);
    } else if (isSimpleSelectorKey(key)) {
      transformComplexStyle(`&${key}`, value, context);
    } else if (isVarsKey(key)) {
      for (const [varKey, varValue] of Object.entries(value)) {
        const transformedVarKey = isCSSVarKey(varKey)
          ? replaceCSSVarKey(varKey)
          : varKey;
        transformCSSVarStyle(transformedVarKey, varValue, context);
      }
    } else if (isCSSVarKey(key)) {
      transformCSSVarStyle(replaceCSSVarKey(key), value, context);
    } else if (isPureCSSVarKey(key)) {
      transformCSSVarStyle(key, value, context);
    } else if (isRuleKey(key)) {
      transformRuleStyle(key, value, context);
    } else {
      transformValueStyle(key, value, context);
    }
  }
  return context.result as StyleRule;
}

function insertResultValue(
  accessKey: string,
  key: string,
  value: unknown,
  context: TransformContext
) {
  if (context.result[accessKey] === undefined) {
    context.result[accessKey] = {};
  }
  (context.result[accessKey] as Record<string, unknown>)[key] = value;
}

function transformComplexStyle(
  key: string,
  value: CSSRuleExistValue,
  context: TransformContext
) {
  if (isPropertyCondition(context)) {
    if (key === "base") {
      context.result[context.basedKey] = value;
    } else {
      insertResultValue(
        "selectors",
        key,
        {
          [context.basedKey]: value
        },
        context
      );
    }
  } else {
    insertResultValue(
      "selectors",
      key,
      transformStyle(value as CSSRule),
      context
    );
  }
}

function transformCSSVarStyle(
  key: string,
  value: CSSRuleExistValue,
  context: TransformContext
) {
  insertResultValue("vars", key, value, context);
}

function transformRuleStyle(
  key: CSSRuleKey,
  value: CSSRuleExistValue,
  context: TransformContext
) {
  const { isToplevelRules, atRuleKey, atRuleNestedKey } = atRuleKeyInfo(key);

  const propertyCondition = isPropertyCondition(context);
  const ruleValue: Record<string, StyleRule> = {};
  if (isToplevelRules) {
    ruleValue[atRuleNestedKey] = propertyCondition
      ? { [context.basedKey]: value }
      : transformStyle(value as CSSRule);
  } else {
    for (const [atRuleNestedKey, atRuleStyle] of Object.entries(value)) {
      ruleValue[atRuleNestedKey] = propertyCondition
        ? { [context.basedKey]: atRuleStyle }
        : transformStyle(atRuleStyle);
    }
  }

  context.result[atRuleKey] = {
    ...(context.result[atRuleKey] ?? {}),
    ...ruleValue
  };
}

function transformValueStyle(
  key: CSSRuleKey,
  value: CSSRuleExistValue,
  context: TransformContext
) {
  const { isMergeToComma, isMergeToSpace, isMergeSymbol } = mergeKeyInfo(key);

  const transformedKey = replacePseudoSelectors(
    isMergeSymbol ? removeMergeSymbol(key) : key
  );

  if (typeof value === "object") {
    Array.isArray(value)
      ? transformArrayValue(
          key,
          value,
          isMergeToComma,
          isMergeToSpace,
          transformedKey,
          context
        )
      : transformObjectValue(key, value, transformedKey, context);
  } else {
    context.result[transformedKey] = transformCommonValue(value);
  }
}

// == Utils ====================================================================
function transformArrayValue<T>(
  key: string,
  values: T[],
  isMergeToComma: boolean,
  isMergeToSpace: boolean,
  transformedKey: string,
  context: TransformContext
) {
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

  if (Array.isArray(transformed)) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: error ts2590: expression produces a union type that is too complex to represent
    context.result[transformedKey] = transformed.map(transformCommonValue);
  } else {
    context.result[transformedKey] = transformed;
  }
}

function transformArrayAnonymousValue(key: string, value: CSSRuleValue) {
  return typeof value === "object" ? transformAnonymous(key, value) : value;
}

function transformObjectValue(
  key: string,
  value: CSSRuleValue,
  transformedKey: string,
  context: TransformContext
) {
  const transformed = transformAnonymous(key, value);
  if (typeof transformed === "string") {
    context.result[transformedKey] = transformed;
  } else {
    context.basedKey = transformedKey;
    transformStyle(value as CSSRule, context);
    context.basedKey = "";
  }
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

function isPropertyCondition(context: TransformContext) {
  return context.basedKey !== "";
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

    it("Simple Psudo Selectors", () => {
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
        selectors: {
          "&:hover": {
            color: "red !important"
          },
          "&::-moz-selection": {
            background: "blue"
          }
        }
      } satisfies StyleRule);
    });

    it("Property conditions", () => {
      expect(
        transformStyle({
          background: {
            base: "red",
            _hover: "green",
            "[disabled]": "blue",
            "nav li > &": "black",
            "@media (prefers-color-scheme: dark)": "white",
            "@media": {
              "screen and (min-width: 768px)": "grey"
            }
          }
        })
      ).toStrictEqual({
        background: "red",
        selectors: {
          "&:hover": {
            background: "green"
          },
          "&[disabled]": {
            background: "blue"
          },
          "nav li > &": {
            background: "black"
          }
        },
        "@media": {
          "(prefers-color-scheme: dark)": {
            background: "white"
          },
          "screen and (min-width: 768px)": {
            background: "grey"
          }
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
        selectors: {
          "&:hover": {
            padding: "calc(var(--my-css-variable2) - 1px)",
            margin: "calc(var(--my-css-variable3) - 1px)"
          }
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
        selectors: {
          "&:hover": {
            // padding:
            //   "calc(var(--my-css-variable2, var(--my-css-variable3, 5px)) - 1px)",
            margin: "calc(var(--my-css-variable4) - 1px)"
          }
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
