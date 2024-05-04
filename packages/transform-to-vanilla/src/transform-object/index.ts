import deepmerge from "@fastify/deepmerge";
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
  anonymousKeyInfo
} from "@/transform-keys/at-rules";
import { removeMergeSymbol, mergeKeyInfo } from "@/transform-keys/merge-key";
import { mergeToComma, mergeToSpace } from "@/transform-values/merge-values";
import { simplyImportant } from "@/transform-values/simply-important";
import { isUppercase } from "@/utils/string";
import { keyframes, fontFace } from "@vanilla-extract/css";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import type { StyleRule } from "@vanilla-extract/css";
import type {
  CSSRule,
  CSSRuleKey,
  CSSRuleValue,
  VanillaStyleRuleValue
} from "@/types/style-rule";

const mergeObject = deepmerge();

// == Interface ================================================================
type StyleResult = {
  // key in StyleRuleKey occur a error
  // Type '{}' is missing the following properties from type
  // '{ accentColor: StyleRuleValue; alignContent: StyleRuleValue; alignItems: StyleRuleValue; alignSelf: StyleRuleValue; ... 904 more ...;
  //  vars: StyleRuleValue; }': accentColor, alignContent, alignItems, alignSelf, and 905 more.ts(2740)
  [key in string]: VanillaStyleRuleValue;
};
type CSSRuleExistValue = Exclude<CSSRuleValue, undefined>;

export interface TransformContext {
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
    CSSRuleKey,
    CSSRuleExistValue
  ][]) {
    if (isSelectorskey(key)) {
      for (const [selector, style] of Object.entries(value)) {
        transformComplexStyle(selector, style, context);
      }
    } else if (isComplexKey(key)) {
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
    } else if (isPropertyNested(context)) {
      transformPropertyNested(key, value, context);
    } else {
      transformValueStyle(key, value, context);
    }
  }
  return context.result as StyleRule;
}

type AccessedResult = Record<string, unknown>;
function insertResultValue(
  accessKey: string,
  key: string,
  value: NonNullable<unknown>,
  context: TransformContext
) {
  if (context.result[accessKey] === undefined) {
    context.result[accessKey] = {};
  }

  if (typeof value === "object" && accessKey in value) {
    const mapValue = new Map(Object.entries(value));
    mapValue.delete(accessKey);

    context.result[accessKey] = mergeObject(context.result[accessKey], {
      ...(mapValue.size > 0 ? { [key]: Object.fromEntries(mapValue) } : {}),
      ...(value as Record<string, object>)[accessKey]
    });
  } else {
    (context.result[accessKey] as AccessedResult)[key] = mergeObject(
      (context.result[accessKey] as AccessedResult)?.[key] ?? {},
      value
    );
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

  const ruleValue: Record<string, StyleRule> = {};
  if (isToplevelRules) {
    createRuleValue(ruleValue, atRuleNestedKey, value, context);
  } else {
    for (const [atRuleNestedKey, atRuleStyle] of Object.entries(value)) {
      createRuleValue(ruleValue, atRuleNestedKey, atRuleStyle, context);
    }
  }

  context.result[atRuleKey] = mergeObject(
    context.result[atRuleKey] ?? {},
    ruleValue
  );
}
function createRuleValue(
  ruleValue: Record<string, unknown>,
  key: string,
  value: CSSRuleExistValue,
  context: TransformContext
) {
  const otherContext = createOtherContext(context);
  transformValueStyle(context.basedKey, value, otherContext);
  ruleValue[key] = otherContext.result;
}
function createOtherContext(context: TransformContext) {
  const otherContext = {
    ...context,
    result: {}
  };
  return otherContext;
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
    transformStyle(value as CSSRule, { ...context, basedKey: transformedKey });
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

  describe.concurrent("Complex transform", () => {
    it("Nested properties", () => {
      expect(
        transformStyle({
          "@media": {
            "screen and (min-width: 768px)": {
              _hover: {
                padding: {
                  BlockEnd: 3,
                  Right: "20px",
                  InlineEnd: ["16px", "1rem"]
                }
              },
              "@supports (display: grid)": {
                background: {
                  Color: "red",
                  Image: "none",
                  Clip: ["initial", "-moz-initial"]
                }
              }
            }
          }
        })
      ).toStrictEqual({
        "@media": {
          "screen and (min-width: 768px)": {
            selectors: {
              "&:hover": {
                paddingBlockEnd: 3,
                paddingRight: "20px",
                paddingInlineEnd: ["16px", "1rem"]
              }
            },
            "@supports": {
              "(display: grid)": {
                backgroundColor: "red",
                backgroundImage: "none",
                backgroundClip: ["initial", "-moz-initial"]
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
