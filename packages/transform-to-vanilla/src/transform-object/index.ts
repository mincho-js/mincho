import {
  isSimplePseudoSelectorKey,
  replacePseudoSelectors
} from "@/transform-keys/simple-pseudo-selectors";
import {
  isSelectorskey,
  isComplexKey,
  isSimpleSelectorKey,
  nestedSelectorKey
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
  anonymousKeyInfo,
  atRuleKeyMerge
} from "@/transform-keys/at-rules";
import { removeMergeSymbol, mergeKeyInfo } from "@/transform-keys/merge-key";
import { mergeToComma, mergeToSpace } from "@/transform-values/merge-values";
import { simplyImportant } from "@/transform-values/simply-important";
import { replacePropertyReference } from "@/transform-values/property-reference";
import { isUppercase } from "@/utils/string";
import { isEmptyObject, mergeObject } from "@/utils/object";
import { keyframes, fontFace } from "@vanilla-extract/css";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import {
  createNestedObject,
  createPathSetter,
  processNestedResult
} from "./rule-context";
import type { StyleRule } from "@vanilla-extract/css";
import type {
  CSSRule,
  CSSRuleKey,
  CSSRuleValue,
  VanillaStyleRuleValue,
  AtRulesKeywords
} from "@/types/style-rule";
import type { Properties } from "@mincho-js/csstype";

// == Interface ================================================================
export type StyleResult = {
  // key in StyleRuleKey occur a error
  // Type '{}' is missing the following properties from type
  // '{ accentColor: StyleRuleValue; alignContent: StyleRuleValue; alignItems: StyleRuleValue; alignSelf: StyleRuleValue; ... 904 more ...;
  //  vars: StyleRuleValue; }': accentColor, alignContent, alignItems, alignSelf, and 905 more.ts(2740)
  [key in string]: VanillaStyleRuleValue;
};
export type CSSRuleExistValue = Exclude<CSSRuleValue, undefined>;

export type AtRulesPrefix = `@${AtRulesKeywords}`;
export interface TransformContext {
  result: StyleResult;
  basedKey: string;
  parentSelector: string;
  parentAtRules: {
    [key in AtRulesPrefix]: string;
  };
  propertyReference: Properties;
  variantMap: Record<string, string>;
  variantReference: Record<string, StyleResult>;
}
export const initTransformContext: TransformContext = {
  result: {},
  basedKey: "",
  parentSelector: "",
  parentAtRules: {
    "@media": "",
    "@supports": "",
    "@container": "",
    "@layer": ""
  },
  propertyReference: {},
  variantMap: {},
  variantReference: {}
};

export function transformStyle(
  style: CSSRule,
  context = structuredClone(initTransformContext)
) {
  const newContext: TransformContext = {
    ...context,
    // @ts-expect-error: error ts2322: Type '`var(--${string})`' is not assignable to type 'Appearance | undefined'
    propertyReference: {
      ...context.propertyReference,
      ...style
    }
  };
  for (const [key, value] of Object.entries(style) as [
    CSSRuleKey,
    CSSRuleExistValue
  ][]) {
    if (isSelectorskey(key)) {
      for (const [selector, style] of Object.entries(value)) {
        transformComplexStyle(selector, style, newContext);
      }
    } else if (isComplexKey(key)) {
      transformComplexStyle(key, value, newContext);
    } else if (isSimplePseudoSelectorKey(key)) {
      transformComplexStyle(
        `&${replacePseudoSelectors(key)}`,
        value,
        newContext
      );
    } else if (isSimpleSelectorKey(key)) {
      transformComplexStyle(`&${key}`, value, newContext);
    } else if (isVarsKey(key)) {
      for (const [varKey, varValue] of Object.entries(value)) {
        const transformedVarKey = isCSSVarKey(varKey)
          ? replaceCSSVarKey(varKey)
          : varKey;
        transformCSSVarStyle(transformedVarKey, varValue, newContext);
      }
    } else if (isCSSVarKey(key)) {
      transformCSSVarStyle(replaceCSSVarKey(key), value, newContext);
    } else if (isPureCSSVarKey(key)) {
      transformCSSVarStyle(key, value, newContext);
    } else if (isRuleKey(key)) {
      transformRuleStyle(key, value, newContext);
    } else if (isPropertyNested(newContext)) {
      transformPropertyNested(key, value, newContext);
    } else {
      transformValueStyle(key, value, newContext);
    }
  }

  mergeVariantReference(context, newContext);
  return newContext.result as StyleRule;
}

type AccessedResult = Record<string, unknown>;
function insertResultValue(
  accessKey: string,
  key: string,
  value: NonNullable<unknown>,
  context: TransformContext
) {
  if (typeof value === "object") {
    for (const [valueKey, valueValue] of Object.entries(value)) {
      if (isRuleKey(valueKey)) {
        context.result[valueKey] = mergeObject(
          (context.result[valueKey] as Record<string, unknown>) ?? {},
          valueValue
        );
      } else if (valueKey === accessKey) {
        context.result[accessKey] = mergeObject(
          (context.result[valueKey] as Record<string, unknown>) ?? {},
          valueValue
        );
      } else {
        if (context.result[accessKey] === undefined) {
          context.result[accessKey] = {};
        }
        (context.result[accessKey] as AccessedResult)[key] = mergeObject(
          (context.result[accessKey] as AccessedResult)?.[key] ?? {},
          { [valueKey]: valueValue }
        );
      }
    }
  } else {
    if (context.result[accessKey] === undefined) {
      context.result[accessKey] = {};
    }
    (context.result[accessKey] as AccessedResult)[key] = value;
  }
}

function transformComplexStyle(
  key: string,
  value: CSSRuleExistValue,
  context: TransformContext
) {
  const selector = isNestedSelector(context)
    ? nestedSelectorKey(key, context)
    : key;

  if (isPropertyNested(context)) {
    if (typeof value === "object" && !Array.isArray(value)) {
      const nestedContext = {
        ...context,
        basedKey: ""
      };
      Object.entries(value).forEach(([key, value]) => {
        const nestedValue = isUppercase(key)
          ? { [context.basedKey + key]: value }
          : {
              [key]: {
                [context.basedKey]: value
              }
            };
        insertSelectorResult(selector, nestedValue, nestedContext);
      });
    } else {
      insertSelectorResult(
        selector,
        {
          [context.basedKey]: value
        },
        context
      );
    }
  } else {
    insertSelectorResult(selector, value, context);
  }
}

function insertSelectorResult(
  selector: string,
  value: CSSRuleExistValue,
  context: TransformContext
) {
  if (selector.includes("%")) {
    const tempContext: TransformContext = {
      ...context,
      result: {},
      parentSelector: selector
    };
    insertVariantReferenceValue(
      selector,
      transformStyle(value as CSSRule, tempContext),
      context
    );

    mergeVariantReference(context, tempContext);
  } else {
    insertResultValue(
      "selectors",
      selector,
      transformStyle(value as CSSRule, {
        ...context,
        result: {},
        parentSelector: selector
      }),
      context
    );
  }
}

function insertVariantReferenceValue(
  key: string,
  value: NonNullable<unknown>,
  context: TransformContext
) {
  const tempContext: TransformContext = {
    ...context,
    parentSelector: ""
  };
  const result: StyleResult = {};
  const pathSetter = createPathSetter(result, tempContext);
  for (const [eachKey, eachValue] of Object.entries(value)) {
    pathSetter(eachKey, eachValue as VanillaStyleRuleValue);
  }

  context.variantReference = mergeObject(
    context.variantReference,
    isEmptyObject(result)
      ? {}
      : {
          [key]: result
        }
  );
}

function transformPropertyNested(
  key: string,
  value: CSSRuleExistValue,
  context: TransformContext
) {
  if (isUppercase(key)) {
    // context.result[context.basedKey + key] = value;
    transformValueStyle(context.basedKey + key, value, context);
  } else if (key === "base") {
    // context.result[context.basedKey] = value;
    transformValueStyle(context.basedKey, value, context);
  } else {
    transformValueStyle(key, value, context);
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

  if (isToplevelRules) {
    createRuleValue(atRuleKey, atRuleNestedKey, value, context);
  } else {
    for (const [atRuleNestedKey, atRuleStyle] of Object.entries(value)) {
      createRuleValue(atRuleKey, atRuleNestedKey, atRuleStyle, context);
    }
  }
}
function createRuleValue(
  atRuleKey: string,
  atRuleNestedKey: string,
  value: CSSRuleExistValue,
  context: TransformContext
) {
  const mergedAtRuleKey = atRuleKeyMerge(
    atRuleKey,
    context.parentAtRules[atRuleKey as AtRulesPrefix],
    atRuleNestedKey
  );
  const otherContext: TransformContext = {
    ...context,
    result: {},
    parentAtRules: {
      ...context.parentAtRules,
      [atRuleKey]: mergedAtRuleKey
    }
  };

  transformValueStyle(context.basedKey, value, otherContext);

  const atRuleResult = createNestedObject(otherContext, otherContext.result);
  mergeVariantReference(context, otherContext);
  processNestedResult(context.result, atRuleResult);
}

function transformValueStyle(
  key: CSSRuleKey | string,
  value: CSSRuleExistValue,
  context: TransformContext
) {
  const { isMergeToComma, isMergeToSpace, isMergeSymbol } = mergeKeyInfo(key);

  const transformedKey = replacePseudoSelectors(
    isMergeSymbol ? removeMergeSymbol(key) : key
  );

  if (typeof value === "object") {
    if (Array.isArray(value)) {
      transformArrayValue(
        key,
        value,
        isMergeToComma,
        isMergeToSpace,
        transformedKey,
        context
      );
    } else {
      transformObjectValue(key, value, transformedKey, context);
    }
  } else {
    context.result[transformedKey] = transformCommonValue(value, context);
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
    context.result[transformedKey] = transformed.map((value) =>
      // @ts-expect-error: error ts2590: expression produces a union type that is too complex to represent
      transformCommonValue(value, context)
    );
  } else {
    context.result[transformedKey] = transformCommonValue(transformed, context);
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
    const tempContext = {
      ...context,
      basedKey: transformedKey
    };
    transformStyle(value as CSSRule, tempContext);
    mergeVariantReference(context, tempContext);
  }
}

function transformAnonymous(key: string, value: CSSRuleValue) {
  const { isAnimationName, isFontFamily } = anonymousKeyInfo(key);

  if (isAnimationName) {
    // @ts-expect-error: error TS2590: Expression produces a union type that is too complex to represent
    return keyframes(value);
  }
  if (isFontFamily) {
    // @ts-expect-error: error TS2590: Expression produces a union type that is too complex to represent
    return fontFace(value);
  }
  return value;
}

function transformCommonValue(value: CSSRuleValue, context: TransformContext) {
  if (typeof value === "string") {
    const result = replacePropertyReference(value, context);
    return typeof result === "string"
      ? simplyImportant(replaceCSSVar(result))
      : result;
  }
  return value;
}

export function mergeVariantReference(
  context: TransformContext,
  tempContext: TransformContext
) {
  context.variantReference = mergeObject(
    context.variantReference,
    tempContext.variantReference
  );
}

function isPropertyNested(context: TransformContext) {
  return context.basedKey !== "";
}

function isNestedSelector(context: TransformContext) {
  return context.parentSelector !== "";
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

    it("Simple Pseudo Selectors", () => {
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

    it("Nested properties", () => {
      expect(
        transformStyle({
          padding: {
            BlockEnd: 3,
            Right: "20px"
          },
          background: {
            Color: "red",
            Image: "none"
          }
        })
      ).toStrictEqual({
        paddingBlockEnd: 3,
        paddingRight: "20px",
        backgroundColor: "red",
        backgroundImage: "none"
      } satisfies StyleRule);

      expect(
        transformStyle({
          background: {
            Color: [
              "#b32323",
              "color(display-p3 .643308 .192455 .167712)",
              "lab(40% 56.6 39)"
            ]
          }
        })
      ).toStrictEqual({
        backgroundColor: [
          "#b32323",
          "color(display-p3 .643308 .192455 .167712)",
          "lab(40% 56.6 39)"
        ]
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

      expect(
        transformStyle({
          background: {
            _hover: {
              base: [
                "#706a43",
                "color-mix(in hsl, hsl(120deg 10% 20%) 25%, hsl(30deg 30% 40%))"
              ],
              Color: [
                "#b32323",
                "color(display-p3 .643308 .192455 .167712)",
                "lab(40% 56.6 39)"
              ]
            },
            "nav > &": {
              Color: {
                base: ["#6a805d", "color(a98-rgb .44091 .49971 .37408)"],
                __after: ["#00c4ff", "hwb(194 0% 0%)"]
              }
            }
          }
        })
      ).toStrictEqual({
        selectors: {
          "&:hover": {
            background: [
              "#706a43",
              "color-mix(in hsl, hsl(120deg 10% 20%) 25%, hsl(30deg 30% 40%))"
            ],
            backgroundColor: [
              "#b32323",
              "color(display-p3 .643308 .192455 .167712)",
              "lab(40% 56.6 39)"
            ]
          },
          "nav > &": {
            backgroundColor: ["#6a805d", "color(a98-rgb .44091 .49971 .37408)"]
          },
          "nav > &::after": {
            backgroundColor: ["#00c4ff", "hwb(194 0% 0%)"]
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

    it("Simply toplevel selector", () => {
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

    it("Nested selectors", () => {
      expect(
        transformStyle({
          "nav li > &": {
            color: "red",
            _hover: {
              color: "green"
            },
            "&:hover:not(:active)": {
              color: "blue"
            },
            ":root[dir=rtl] &": {
              color: "black"
            }
          }
        })
      ).toStrictEqual({
        selectors: {
          "nav li > &": {
            color: "red"
          },
          "nav li > &:hover": {
            color: "green"
          },
          "nav li > &:hover:not(:active)": {
            color: "blue"
          },
          ":root[dir=rtl] nav li > &": {
            color: "black"
          }
        }
      } satisfies StyleRule);

      expect(
        transformStyle({
          _hover: {
            _active: {
              color: "red",
              "& li": {
                color: "green"
              },
              "li > &": {
                color: "blue"
              }
            }
          }
        })
      ).toStrictEqual({
        selectors: {
          "&:hover:active": {
            color: "red"
          },
          "&:hover:active li": {
            color: "green"
          },
          "li > &:hover:active": {
            color: "blue"
          }
        }
      } satisfies StyleRule);

      expect(
        transformStyle({
          _hover: {
            color: {
              base: "red",
              __before: "green",
              _focus: {
                __after: "blue",
                "nav > &": "black"
              }
            }
          }
        })
      ).toStrictEqual({
        selectors: {
          "&:hover": {
            color: "red"
          },
          "&:hover::before": {
            color: "green"
          },
          "&:hover:focus::after": {
            color: "blue"
          },
          "nav > &:hover:focus": {
            color: "black"
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

    it("Nested AtRules", () => {
      expect(
        transformStyle({
          "@media (prefers-color-scheme: dark)": {
            color: "red",
            "@media (min-width: 768px)": {
              color: {
                base: "green",
                "@media": {
                  print: "blue"
                }
              }
            }
          },

          "@supports (display: table-cell)": {
            "@supports": {
              "(display: list-item)": {
                color: "cyan"
              },
              "(display: contents)": {
                color: "magenta"
              }
            }
          },

          "@container tall (width > 400px)": {
            "@container": {
              "(height > 30rem)": {
                color: "-moz-initial"
              },
              "(orientation: landscape)": {
                color: "Highlight"
              }
            }
          },

          "@layer framework": {
            "@layer": {
              layout: {
                color: "black"
              },
              utilities: {
                color: "white"
              }
            }
          }
        })
      ).toStrictEqual({
        "@media": {
          "(prefers-color-scheme: dark)": {
            color: "red"
          },
          "(prefers-color-scheme: dark) and (min-width: 768px)": {
            color: "green"
          },
          "(prefers-color-scheme: dark) and (min-width: 768px) and print": {
            color: "blue"
          }
        },

        "@supports": {
          "(display: table-cell) and (display: list-item)": {
            color: "cyan"
          },
          "(display: table-cell) and (display: contents)": {
            color: "magenta"
          }
        },

        "@container": {
          "tall (width > 400px) and (height > 30rem)": {
            color: "-moz-initial"
          },
          "tall (width > 400px) and (orientation: landscape)": {
            color: "Highlight"
          }
        },

        "@layer": {
          "framework.layout": {
            color: "black"
          },
          "framework.utilities": {
            color: "white"
          }
        }
      } satisfies StyleRule);
    });

    it("Nested AtRules multiple", () => {
      expect(
        transformStyle({
          "@media (prefers-color-scheme: dark)": {
            color: "red",
            "@media (min-width: 768px)": {
              color: {
                base: "green",
                "@media": {
                  print: "blue"
                }
              },
              "@supports (display: grid)": {
                color: "black"
              }
            }
          }
        })
      ).toStrictEqual({
        "@media": {
          "(prefers-color-scheme: dark)": {
            color: "red"
          },
          "(prefers-color-scheme: dark) and (min-width: 768px)": {
            color: "green"
          },
          "(prefers-color-scheme: dark) and (min-width: 768px) and print": {
            color: "blue"
          }
        },
        "@supports": {
          "(display: grid)": {
            "@media": {
              "(prefers-color-scheme: dark) and (min-width: 768px)": {
                color: "black"
              }
            }
          }
        }
      } satisfies StyleRule);
    });

    it("Nested selector & AtRules", () => {
      expect(
        transformStyle({
          "@media (prefers-color-scheme: dark)": {
            "nav li > &": {
              _hover: {
                background: "red"
              }
            }
          }
        })
      ).toStrictEqual({
        "@media": {
          "(prefers-color-scheme: dark)": {
            selectors: {
              "nav li > &:hover": {
                background: "red"
              }
            }
          }
        }
      } satisfies StyleRule);

      // Case with top level selector
      expect(
        transformStyle({
          "nav li > &": {
            background: "red",
            "@media (prefers-color-scheme: dark)": {
              background: "blue",
              _hover: {
                background: "white"
              }
            }
          }
        })
      ).toStrictEqual({
        selectors: {
          "nav li > &": {
            background: "red"
          }
        },
        "@media": {
          "(prefers-color-scheme: dark)": {
            selectors: {
              "nav li > &": {
                background: "blue"
              },
              "nav li > &:hover": {
                background: "white"
              }
            }
          }
        }
      } satisfies StyleRule);

      // Case without top level selector
      expect(
        transformStyle({
          "nav li > &": {
            "@media (prefers-color-scheme: dark)": {
              background: "blue",
              _hover: {
                background: "white"
              }
            }
          }
        })
      ).toStrictEqual({
        "@media": {
          "(prefers-color-scheme: dark)": {
            selectors: {
              "nav li > &": {
                background: "blue"
              },
              "nav li > &:hover": {
                background: "white"
              }
            }
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

    it("Property Reference", () => {
      expect(
        transformStyle({
          width: "50px",
          height: "@width",
          margin: "calc(@width / 2)",
          paddingInline: "calc(@width + @height)",
          paddingBlock: "@margin"
        })
      ).toStrictEqual({
        width: "50px",
        height: "50px",
        margin: "calc(50px / 2)",
        paddingInline: "calc(50px + 50px)",
        paddingBlock: "calc(50px / 2)"
      } satisfies StyleRule);
    });

    it("Property Reference & Merge Values", () => {
      expect(
        transformStyle({
          padding: "10px",
          background: "black",
          boxShadow$: ["inset 0 0 @padding #555", "0 0 20px @background"],

          lineHeight: 2,
          rotate: "15deg",
          transform_: ["scale(@lineHeight)", "rotate(@rotate)"]
        })
      ).toStrictEqual({
        padding: "10px",
        background: "black",
        boxShadow: "inset 0 0 10px #555, 0 0 20px black",

        lineHeight: 2,
        rotate: "15deg",
        transform: "scale(2) rotate(15deg)"
      } satisfies StyleRule);
    });

    it("Property Reference & Fallback style", () => {
      expect(
        transformStyle({
          fontSize: "1rem",
          padding: ["16px", "@fontSize"],
          margin: "@padding"
        })
      ).toStrictEqual({
        fontSize: "1rem",
        padding: ["16px", "1rem"],
        margin: ["16px", "1rem"]
      } satisfies StyleRule);
    });

    it("Property Reference & Nested", () => {
      expect(
        transformStyle({
          padding: "10px",
          _hover: {
            margin: "@padding"
          }
        })
      ).toStrictEqual({
        padding: "10px",
        selectors: {
          "&:hover": {
            margin: "10px"
          }
        }
      } satisfies StyleRule);

      expect(
        transformStyle({
          padding: "10px",
          _hover: {
            margin: "@padding",
            padding: "20px"
          }
        })
      ).toStrictEqual({
        padding: "10px",
        selectors: {
          "&:hover": {
            margin: "20px",
            padding: "20px"
          }
        }
      } satisfies StyleRule);

      expect(
        transformStyle({
          "nav li > &": {
            background: "red",
            "@media (prefers-color-scheme: dark)": {
              background: "blue",
              _hover: {
                color: "@background"
              }
            }
          }
        })
      ).toStrictEqual({
        selectors: {
          "nav li > &": {
            background: "red"
          }
        },
        "@media": {
          "(prefers-color-scheme: dark)": {
            selectors: {
              "nav li > &": {
                background: "blue"
              },
              "nav li > &:hover": {
                color: "blue"
              }
            }
          }
        }
      } satisfies StyleRule);
    });

    it("Variant Reference", () => {
      const context = structuredClone(initTransformContext);
      expect(
        transformStyle(
          {
            "&:hover:not(:active) %someVariant": {
              border: "2px solid red"
            },
            "nav li > &": {
              textDecoration: "underline"
            },
            selectors: {
              "a:nth-of-type(2) &": {
                opacity: 1
              }
            }
          },
          context
        )
      ).toStrictEqual({
        selectors: {
          "nav li > &": {
            textDecoration: "underline"
          },
          "a:nth-of-type(2) &": {
            opacity: 1
          }
        }
      } satisfies StyleRule);

      expect(context.variantReference).toStrictEqual({
        "&:hover:not(:active) %someVariant": {
          border: "2px solid red"
        }
      } satisfies Record<string, StyleRule>);

      const variantContext = structuredClone(initTransformContext);
      const result = transformStyle(
        {
          "@media (prefers-color-scheme: dark)": {
            "&:hover:not(:active) %someVariant": {
              "@supports (display: grid)": {
                border: "2px solid blue"
              },
              "nav li > &": {
                textDecoration: "underline"
              }
            }
          }
        },
        variantContext
      );
      expect(result).toStrictEqual({} satisfies StyleRule);

      expect(variantContext.variantReference).toStrictEqual({
        "&:hover:not(:active) %someVariant": {
          "@supports": {
            "(display: grid)": {
              "@media": {
                "(prefers-color-scheme: dark)": {
                  border: "2px solid blue"
                }
              }
            }
          }
        },
        "nav li > &:hover:not(:active) %someVariant": {
          "@media": {
            "(prefers-color-scheme: dark)": {
              textDecoration: "underline"
            }
          }
        }
      } satisfies Record<string, StyleRule>);
    });
  });

  describe.concurrent("Complex transform", () => {
    it("Nested properties", () => {
      expect(
        transformStyle({
          "@media": {
            "screen and (min-width: 768px)": {
              margin: 10,
              _hover: {
                padding: {
                  BlockEnd: 3,
                  Right: "20px",
                  Left: "@margin",
                  InlineStart: ["@Left", "@Right"],
                  InlineEnd: ["16px", "1rem"]
                }
              },
              "@supports (display: grid)": {
                background: {
                  Color: "red",
                  Image: "none",
                  Clip: ["initial", "-moz-initial"],
                  Attachment: "@Clip"
                }
              }
            }
          }
        })
      ).toStrictEqual({
        "@media": {
          "screen and (min-width: 768px)": {
            margin: 10,
            selectors: {
              "&:hover": {
                paddingBlockEnd: 3,
                paddingRight: "20px",
                paddingLeft: 10,
                paddingInlineStart: [10, "20px"],
                paddingInlineEnd: ["16px", "1rem"]
              }
            }
          }
        },
        "@supports": {
          "(display: grid)": {
            "@media": {
              "screen and (min-width: 768px)": {
                backgroundColor: "red",
                backgroundImage: "none",
                backgroundClip: ["initial", "-moz-initial"],
                backgroundAttachment: ["initial", "-moz-initial"]
              }
            }
          }
        }
      } satisfies StyleRule);
    });

    it("Property conditions", () => {
      expect(
        transformStyle({
          "@supports (display: grid)": {
            background: {
              base: "red",
              _hover: "green",
              _active: "@base",
              "[disabled]": "blue",
              "nav li > &": "black",
              "@media (prefers-color-scheme: dark)": "white",
              "@media": {
                "screen and (min-width: 768px)": ["#00c4ff", "hwb(194 0% 0%)"]
              },

              // With Nested property
              Color: {
                base: "transparent",
                _hover: "Highlight",
                _active: "@_hover",
                "@media (prefers-reduced-motion)": "MenuText"
              },
              "@media (prefers-reduced-motion)": {
                Image: {
                  base: ["none", "-moz-initial"],
                  _hover: ["unset", "-moz-initial"]
                }
              }
            }
          }
        })
      ).toStrictEqual({
        "@supports": {
          "(display: grid)": {
            background: "red",
            backgroundColor: "transparent",
            selectors: {
              "&:hover": {
                background: "green",
                backgroundColor: "Highlight"
              },
              "&:active": {
                background: "red",
                backgroundColor: "Highlight"
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
                background: ["#00c4ff", "hwb(194 0% 0%)"]
              },
              "(prefers-reduced-motion)": {
                backgroundColor: "MenuText",

                backgroundImage: ["none", "-moz-initial"],
                selectors: {
                  "&:hover": {
                    backgroundImage: ["unset", "-moz-initial"]
                  }
                }
              }
            }
          }
        }
      } satisfies StyleRule);
    });
  });
}
