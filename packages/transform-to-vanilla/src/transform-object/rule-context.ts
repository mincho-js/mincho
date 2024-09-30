import { setFileScope } from "@vanilla-extract/css/fileScope";
import { isRuleKey, atRuleKeyMerge } from "@/transform-keys/at-rules";
import { initTransformContext } from "./index";
import { mergeObject } from "@/utils/object";
import type { StyleResult, AtRulesPrefix, TransformContext } from "./index";
import type { VanillaStyleRuleValue } from "@/types/style-rule";

const AT_RULE_ORDER: AtRulesPrefix[] = [
  "@layer",
  "@supports",
  "@media",
  "@container"
];

export function createNestedObject(
  context: TransformContext,
  target: StyleResult
): StyleResult {
  const result: StyleResult = {};
  const pathSetter = createPathSetter(result, context);

  for (const [key, value] of Object.entries(target)) {
    if (isRuleKey(key)) {
      processRules(key as AtRulesPrefix, value as object, context, result);
    } else if (key === "selectors") {
      processSelectors(value as object, context, result);
    } else {
      pathSetter(key, value);
    }
  }
  return result;
}

export function createPathSetter(
  result: StyleResult,
  context: TransformContext
) {
  const nestedPath = AT_RULE_ORDER.filter(
    (rule) => context.parentAtRules[rule]
  ).flatMap((rule) => [rule, context.parentAtRules[rule]]);

  const isVariantReference = context.parentSelector.includes("%");
  if (context.parentSelector && !isVariantReference) {
    nestedPath.push("selectors", context.parentSelector);
  }

  const variantResult: StyleResult = {};
  return (key: string, value: VanillaStyleRuleValue) => {
    let current = isVariantReference ? variantResult : result;
    // Prevent  Prototype-polluting assignment
    // https://codeql.github.com/codeql-query-help/javascript/js-prototype-polluting-assignment/
    for (const path of nestedPath) {
      if (
        path !== "__proto__" &&
        path !== "constructor" &&
        path !== "prototype" &&
        current[path] === undefined
      ) {
        current[path] = {};
      }
      current = (current[path] as StyleResult) || ({} as StyleResult);
    }
    if (key !== "__proto__" && key !== "constructor" && key !== "prototype") {
      current[key] = value;
    }

    if (isVariantReference) {
      context.variantReference = mergeObject(context.variantReference, {
        [context.parentSelector]: variantResult
      });
    }
  };
}

function processRules(
  key: AtRulesPrefix,
  value: object,
  context: TransformContext,
  result: StyleResult
) {
  for (const [atRule, atRuleValue] of Object.entries(value)) {
    const tempContext: TransformContext = {
      ...context,
      parentAtRules: {
        ...context.parentAtRules,
        [key]: atRuleKeyMerge(key, context.parentAtRules[key], atRule)
      }
    };
    const nestedResult = createNestedObject(tempContext, atRuleValue);
    context.variantReference = mergeObject(
      context.variantReference,
      tempContext.variantReference
    );

    processNestedResult(result, nestedResult);
  }
}

function processSelectors(
  value: object,
  context: TransformContext,
  result: StyleResult
) {
  for (const [selector, selectorValue] of Object.entries(value)) {
    const tempContext: TransformContext = {
      ...context,
      parentSelector: selector
    };
    const nestedResult = createNestedObject(tempContext, selectorValue);
    context.variantReference = mergeObject(
      context.variantReference,
      tempContext.variantReference
    );
    processNestedResult(result, nestedResult);
  }
}

export function processNestedResult(
  result: StyleResult,
  nestedResult: StyleResult
) {
  for (const [atRule, atRuleValue] of Object.entries(nestedResult)) {
    result[atRule] = mergeObject(
      (result[atRule] as Record<string, unknown>) ?? {},
      (atRuleValue as Record<string, unknown>) ?? {}
    );
  }
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  setFileScope("test");

  describe.concurrent("createNestedObject", () => {
    it("should create nested objects based on context rules", () => {
      const context: TransformContext = {
        ...structuredClone(initTransformContext),
        parentSelector: "nav li > &",
        parentAtRules: {
          "@layer": "framework.layout",
          "@supports": "gap: 1rem",
          "@media": "(prefers-color-scheme: dark) and (prefers-reduced-motion)",
          "@container": "(min-width: 500px)"
        }
      };
      const target: StyleResult = { color: "red" };

      expect(createNestedObject(context, target)).toStrictEqual({
        "@layer": {
          "framework.layout": {
            "@supports": {
              "gap: 1rem": {
                "@media": {
                  "(prefers-color-scheme: dark) and (prefers-reduced-motion)": {
                    "@container": {
                      "(min-width: 500px)": {
                        selectors: {
                          "nav li > &": { color: "red" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      });
    });

    it("should handle empty parentSelector", () => {
      const context: TransformContext = {
        ...structuredClone(initTransformContext),
        parentSelector: "",
        parentAtRules: {
          "@layer": "framework.layout",
          "@supports": "gap: 1rem",
          "@media": "(prefers-color-scheme: dark) and (prefers-reduced-motion)",
          "@container": "(min-width: 500px)"
        }
      };
      const target: StyleResult = { color: "red" };

      expect(createNestedObject(context, target)).toStrictEqual({
        "@layer": {
          "framework.layout": {
            "@supports": {
              "gap: 1rem": {
                "@media": {
                  "(prefers-color-scheme: dark) and (prefers-reduced-motion)": {
                    "@container": {
                      "(min-width: 500px)": {
                        color: "red"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      });
    });

    it("should handle empty parentAtRules", () => {
      const context: TransformContext = {
        ...structuredClone(initTransformContext),
        parentSelector: "nav li > &",
        parentAtRules: {
          "@layer": "",
          "@supports": "",
          "@media": "",
          "@container": ""
        }
      };
      const target: StyleResult = { color: "red" };

      expect(createNestedObject(context, target)).toStrictEqual({
        selectors: {
          "nav li > &": { color: "red" }
        }
      });
    });

    it("should handle parentSelector", () => {
      const context: TransformContext = {
        ...structuredClone(initTransformContext),
        parentSelector: "nav li > &",
        parentAtRules: {
          "@media": "(prefers-color-scheme: dark)",
          "@supports": "",
          "@container": "",
          "@layer": ""
        }
      };
      const target: StyleResult = {
        background: "red",
        selectors: {
          "nav li > &:hover": {
            background: "blue"
          }
        }
      };

      expect(createNestedObject(context, target)).toStrictEqual({
        "@media": {
          "(prefers-color-scheme: dark)": {
            selectors: {
              "nav li > &": {
                background: "red"
              },
              "nav li > &:hover": {
                background: "blue"
              }
            }
          }
        }
      });
    });

    it("should merge with nested object", () => {
      const context: TransformContext = {
        ...structuredClone(initTransformContext),
        parentSelector: "nav li > &",
        parentAtRules: {
          "@layer": "framework.layout",
          "@supports": "",
          "@media": "(prefers-color-scheme: dark) and (prefers-reduced-motion)",
          "@container": "(min-width: 500px)"
        }
      };
      const target: StyleResult = {
        color: "red",
        "@media": {
          "(prefers-color-scheme: dark) and (prefers-reduced-motion)": {
            "@container": {
              "(max-width: 600px)": {
                color: "green"
              }
            }
          },
          "(prefers-reduced-motion)": {
            color: "blue"
          }
        }
      };

      expect(createNestedObject(context, target)).toStrictEqual({
        "@layer": {
          "framework.layout": {
            "@media": {
              // Keeps because it's the same value
              "(prefers-color-scheme: dark) and (prefers-reduced-motion)": {
                "@container": {
                  "(min-width: 500px)": {
                    selectors: {
                      "nav li > &": {
                        // Values that were at the top level are nested like in the previous test
                        color: "red"
                      }
                    }
                  },
                  // Concatenate with `and` when nested
                  "(min-width: 500px) and (max-width: 600px)": {
                    selectors: {
                      "nav li > &": { color: "green" }
                    }
                  }
                }
              },

              // Concatenate with `and` when nested
              "(prefers-color-scheme: dark) and (prefers-reduced-motion) and (prefers-reduced-motion)":
                {
                  "@container": {
                    "(min-width: 500px)": {
                      selectors: {
                        "nav li > &": { color: "blue" }
                      }
                    }
                  }
                }
            }
          }
        }
      });
    });

    it("should merge with nested object - Check for empty objects", () => {
      const context: TransformContext = {
        ...structuredClone(initTransformContext),
        parentSelector: "",
        parentAtRules: {
          "@media": "(prefers-color-scheme: dark)",
          "@supports": "",
          "@container": "",
          "@layer": ""
        }
      };
      const target: StyleResult = {
        color: "red",
        "@media": {
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
      };

      expect(createNestedObject(context, target)).toStrictEqual({
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
      });
    });

    it("should support variant reference", () => {
      const context: TransformContext = {
        ...structuredClone(initTransformContext),
        parentSelector: "&:hover:not(:active) %someVariant",
        parentAtRules: {
          "@media": "(prefers-color-scheme: dark)",
          "@supports": "",
          "@container": "",
          "@layer": ""
        }
      };
      const target: StyleResult = {
        background: "red",
        selectors: {
          "&:hover:not(:active) %someVariant:focus": {
            background: "blue"
          }
        }
      };

      expect(createNestedObject(context, target)).toStrictEqual({});
      expect(context.variantReference).toStrictEqual({
        "&:hover:not(:active) %someVariant": {
          "@media": {
            "(prefers-color-scheme: dark)": {
              background: "red"
            }
          }
        },
        "&:hover:not(:active) %someVariant:focus": {
          "@media": {
            "(prefers-color-scheme: dark)": {
              background: "blue"
            }
          }
        }
      });
    });
  });

  describe.concurrent("processNestedResult", () => {
    it("should merge nested results correctly", () => {
      const result = {
        "@supports": {
          "(display: grid)": {
            "@media": {
              "(prefers-color-scheme: dark) and (min-width: 768px)": {
                color: "black"
              }
            }
          }
        }
      };
      const nestedResult = {
        color: "red",
        "@supports": {
          "(display: grid)": {
            "@media": {
              "(prefers-color-scheme: dark) and (min-width: 768px) and print": {
                color: "blue"
              }
            }
          }
        }
      };

      processNestedResult(result, nestedResult);
      expect(result).toStrictEqual({
        color: "red",
        "@supports": {
          "(display: grid)": {
            "@media": {
              "(prefers-color-scheme: dark) and (min-width: 768px)": {
                color: "black"
              },
              "(prefers-color-scheme: dark) and (min-width: 768px) and print": {
                color: "blue"
              }
            }
          }
        }
      });
    });

    it("should overlapping values are appended with a trailing value", () => {
      const result = {
        "@supports": {
          "(display: grid)": {
            "@media": {
              "(prefers-color-scheme: dark) and (min-width: 768px)": {
                color: "black"
              }
            }
          }
        }
      };
      const nestedResult = {
        color: "red",
        "@supports": {
          "(display: grid)": {
            "@media": {
              "(prefers-color-scheme: dark) and (min-width: 768px)": {
                color: "green"
              },
              "(prefers-color-scheme: dark) and (min-width: 768px) and print": {
                color: "blue"
              }
            }
          }
        }
      };

      processNestedResult(result, nestedResult);
      expect(result).toStrictEqual(nestedResult);
    });
  });
}
