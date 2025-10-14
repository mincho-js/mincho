import {
  transform,
  replaceVariantReference,
  initTransformContext
} from "@mincho-js/transform-to-vanilla";
import type {
  TransformContext,
  CSSRule,
  ComplexCSSRule,
  GlobalCSSRule,
  AtRulesKeywords
} from "@mincho-js/transform-to-vanilla";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import { style as vStyle, globalStyle as gStyle } from "@vanilla-extract/css";
import type { GlobalStyleRule } from "@vanilla-extract/css";
import { identifierName, getDebugName } from "../utils.js";
import type { CSSRuleWith } from "./types.js";

// == Global CSS ===============================================================
export function globalCss(selector: string, rule: GlobalCSSRule) {
  const transformedStyle = transform({
    selectors: {
      [selector]: {
        ...rule
      }
    }
  }) as CSSRule;

  const { selectors, ...atRuleStyles } = transformedStyle;
  if (selectors !== undefined) {
    Object.entries(selectors).forEach(([selector, styles]) => {
      gStyle(selector, styles as GlobalStyleRule);
    });
  }

  if (atRuleStyles !== undefined) {
    const otherStyles = hoistSelectors(atRuleStyles);
    Object.entries(otherStyles.selectors).forEach(([atRule, atRuleStyles]) => {
      gStyle(atRule, atRuleStyles as GlobalStyleRule);
    });
  }
}

type AtRulePath = readonly [atRule: string, condition: string][];
interface TypeSafeHoistResult {
  readonly selectors: Record<string, CSSRule>;
}

function hoistSelectors(input: CSSRule): TypeSafeHoistResult {
  const result: TypeSafeHoistResult = {
    selectors: {}
  };

  function processRule(rule: CSSRule, path: AtRulePath = []): void {
    // Handle selectors property with type safety
    if (hasSelectorsProperty(rule)) {
      for (const [selector, styles] of Object.entries(rule.selectors)) {
        if (!result.selectors[selector]) {
          result.selectors[selector] = {};
        }

        // Build nested structure using path with type safety
        let current = result.selectors[selector] as Record<string, unknown>;
        for (const [atRule, condition] of path) {
          if (!current[atRule]) {
            current[atRule] = {};
          }
          const atRuleObj = current[atRule] as Record<string, unknown>;
          if (!atRuleObj[condition]) {
            atRuleObj[condition] = {};
          }
          current = atRuleObj[condition] as Record<string, unknown>;
        }

        // Safely merge styles
        Object.assign(current, styles);
      }
    }

    // Process at-rules with type safety
    for (const [key, value] of Object.entries(rule)) {
      if (isAtRuleKey(key) && isAtRuleObject(value)) {
        for (const [condition, nestedRule] of Object.entries(value)) {
          if (typeof nestedRule === "object" && nestedRule !== null) {
            processRule(
              nestedRule as CSSRule,
              [...path, [key, condition]] as const
            );
          }
        }
      }
    }
  }

  processRule(input);
  return result;
}

function hasSelectorsProperty(obj: unknown): obj is TypeSafeHoistResult {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "selectors" in obj &&
    typeof obj.selectors === "object" &&
    obj.selectors !== null
  );
}

function isAtRuleKey(
  key: string
): key is `@${AtRulesKeywords}` | `@${AtRulesKeywords} ${string}` {
  return (
    key.startsWith("@") &&
    (key.startsWith("@media") ||
      key.startsWith("@supports") ||
      key.startsWith("@container") ||
      key.startsWith("@layer"))
  );
}

function isAtRuleObject(value: unknown): value is Record<string, CSSRule> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// == CSS ======================================================================
export const css = Object.assign(cssImpl, {
  raw: cssRaw,
  multiple: cssMultiple,
  with: cssWith
});

function cssRaw(style: ComplexCSSRule) {
  return style;
}

export function cssImpl(style: ComplexCSSRule, debugId?: string) {
  return vStyle(transform(style), debugId);
}

function cssWith<const T extends CSSRule>(
  callback?: (style: CSSRuleWith<T>) => ComplexCSSRule
) {
  type RestrictedCSSRule = CSSRuleWith<T>;
  const cssFunction = callback ?? ((style: RestrictedCSSRule) => style);

  function cssWithImpl(style: RestrictedCSSRule, debugId?: string) {
    return cssImpl(cssFunction(style), debugId);
  }
  function cssWithRaw(style: RestrictedCSSRule) {
    return cssRaw(cssFunction(style));
  }

  function cssWithMultiple<
    StyleMap extends Record<string | number, RestrictedCSSRule>
  >(styleMap: StyleMap, debugId?: string): Record<keyof StyleMap, string> {
    // TODO: Use css.with supported data mapping when available
    // Transform each value using cssFunction
    type TransformedStyleMap = Record<keyof StyleMap, ComplexCSSRule>;
    const transformedStyleMap: TransformedStyleMap = {} as TransformedStyleMap;
    for (const key in styleMap) {
      transformedStyleMap[key] = cssFunction(styleMap[key]);
    }
    return cssMultiple(transformedStyleMap, debugId);
  }

  return Object.assign(cssWithImpl, {
    raw: cssWithRaw,
    multiple: cssWithMultiple
  });
}

// == CSS Multiple =============================================================
// TODO: Need to optimize
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions/get#smart_self-overwriting_lazy_getters
// https://github.com/vanilla-extract-css/vanilla-extract/blob/master/packages/css/src/style.ts
export function cssMultiple<
  StyleMap extends Record<string | number, ComplexCSSRule>
>(styleMap: StyleMap, debugId?: string): Record<keyof StyleMap, string> {
  return processMultiple(styleMap, debugId) as Record<keyof StyleMap, string>;
}

function processMultiple(
  items: Record<string | number, ComplexCSSRule>,
  debugId?: string
): Record<string | number, string> {
  const contexts: TransformContext[] = [];
  const variantMap: Record<string, string> = {};
  const classMap: Record<string | number, string> = {};

  for (const key in items) {
    const context = structuredClone(initTransformContext);
    const className = vStyle(
      transform(items[key], context),
      getDebugName(debugId, key)
    );
    contexts.push(context);
    variantMap[`%${key}`] = className;
    classMap[key] = className;
  }

  for (const context of contexts) {
    context.variantMap = variantMap;
    replaceVariantReference(context);
    for (const [key, value] of Object.entries(context.variantReference)) {
      globalCss(key, value as CSSRule);
    }
  }

  return classMap;
}

export function mincho$<T>(block: () => T) {
  return block();
}

export function selector(selector: string): `&` {
  return selector as `&`;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, assert, expect, vi } = import.meta.vitest;

  const debugId = "myCSS";
  setFileScope("test");

  describe.concurrent("hoistSelectors()", () => {
    it("should hoist simple selector from @media", () => {
      const input: CSSRule = {
        "@media": {
          "screen and (min-width: 768px)": {
            selectors: {
              "&:hover": {
                color: "red"
              }
            }
          }
        }
      };

      const result = hoistSelectors(input);

      expect(result).toEqual({
        selectors: {
          "&:hover": {
            "@media": {
              "screen and (min-width: 768px)": {
                color: "red"
              }
            }
          }
        }
      });
    });

    it("should hoist multiple selectors from single @media", () => {
      const input: CSSRule = {
        "@media": {
          "screen and (min-width: 768px)": {
            selectors: {
              "&:hover": {
                color: "red"
              },
              "&:focus": {
                color: "blue"
              }
            }
          }
        }
      };

      const result = hoistSelectors(input);

      expect(result).toEqual({
        selectors: {
          "&:hover": {
            "@media": {
              "screen and (min-width: 768px)": {
                color: "red"
              }
            }
          },
          "&:focus": {
            "@media": {
              "screen and (min-width: 768px)": {
                color: "blue"
              }
            }
          }
        }
      });
    });

    it("should hoist selectors from nested @media and @supports", () => {
      const input: CSSRule = {
        "@media": {
          "screen and (min-width: 768px)": {
            "@supports": {
              "(display: grid)": {
                selectors: {
                  "&:hover": {
                    display: "grid"
                  }
                }
              }
            }
          }
        }
      };

      const result = hoistSelectors(input);

      expect(result).toEqual({
        selectors: {
          "&:hover": {
            "@media": {
              "screen and (min-width: 768px)": {
                "@supports": {
                  "(display: grid)": {
                    display: "grid"
                  }
                }
              }
            }
          }
        }
      });
    });

    it("should handle multiple nested at-rules with same selector", () => {
      const input: CSSRule = {
        "@media": {
          "screen and (min-width: 768px)": {
            selectors: {
              "&:hover": {
                color: "red"
              }
            }
          },
          "screen and (min-width: 1024px)": {
            selectors: {
              "&:hover": {
                color: "blue"
              }
            }
          }
        }
      };

      const result = hoistSelectors(input);

      expect(result).toEqual({
        selectors: {
          "&:hover": {
            "@media": {
              "screen and (min-width: 768px)": {
                color: "red"
              },
              "screen and (min-width: 1024px)": {
                color: "blue"
              }
            }
          }
        }
      });
    });

    it("should handle @supports at-rule", () => {
      const input: CSSRule = {
        "@supports": {
          "(display: flex)": {
            selectors: {
              "&:hover": {
                display: "flex"
              }
            }
          }
        }
      };

      const result = hoistSelectors(input);

      expect(result).toEqual({
        selectors: {
          "&:hover": {
            "@supports": {
              "(display: flex)": {
                display: "flex"
              }
            }
          }
        }
      });
    });

    it("should handle deeply nested at-rules (3 levels)", () => {
      const input: CSSRule = {
        "@media": {
          screen: {
            "@supports": {
              "(display: grid)": {
                "@layer": {
                  utilities: {
                    selectors: {
                      "&:hover": {
                        display: "grid",
                        gap: "1rem"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      };

      const result = hoistSelectors(input);

      expect(result).toEqual({
        selectors: {
          "&:hover": {
            "@media": {
              screen: {
                "@supports": {
                  "(display: grid)": {
                    "@layer": {
                      utilities: {
                        display: "grid",
                        gap: "1rem"
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

    it("should preserve multiple style properties in hoisted selectors", () => {
      const input: CSSRule = {
        "@media": {
          "screen and (min-width: 768px)": {
            selectors: {
              "&:hover": {
                color: "red",
                backgroundColor: "blue",
                fontSize: "16px",
                padding: "10px"
              }
            }
          }
        }
      };

      const result = hoistSelectors(input);

      expect(result).toEqual({
        selectors: {
          "&:hover": {
            "@media": {
              "screen and (min-width: 768px)": {
                color: "red",
                backgroundColor: "blue",
                fontSize: "16px",
                padding: "10px"
              }
            }
          }
        }
      });
    });

    it("should handle empty selectors object", () => {
      const input: CSSRule = {
        "@media": {
          screen: {}
        }
      };

      const result = hoistSelectors(input);

      expect(result).toEqual({
        selectors: {}
      });
    });

    it("should return empty selectors for input without selectors", () => {
      const input: CSSRule = {
        "@media": {
          screen: {
            color: "red"
          }
        }
      };

      const result = hoistSelectors(input);

      expect(result).toEqual({
        selectors: {}
      });
    });

    it("should handle complex selector strings", () => {
      const input: CSSRule = {
        "@media": {
          print: {
            selectors: {
              "& > .child": {
                display: "none"
              },
              "&:not(:first-child)": {
                marginTop: "1rem"
              }
            }
          }
        }
      };

      const result = hoistSelectors(input);

      expect(result).toEqual({
        selectors: {
          "& > .child": {
            "@media": {
              print: {
                display: "none"
              }
            }
          },
          "&:not(:first-child)": {
            "@media": {
              print: {
                marginTop: "1rem"
              }
            }
          }
        }
      });
    });
  });

  describe.concurrent("css()", () => {
    it("className", () => {
      // myCSS__[HASH]
      const result = css({ color: "red" }, debugId);

      assert.isString(result);
      expect(result).toMatch(identifierName(debugId));
    });

    it("composition", () => {
      const base = css({ padding: 12 }, "base");
      const result = css([base, { color: "red" }], debugId);

      assert.isString(result);
      expect(result).toMatch(identifierName(debugId, "base"));
    });
  });

  describe.concurrent("css.raw()", () => {
    it("handles simple CSS properties", () => {
      const style = {
        color: "red",
        fontSize: 16,
        padding: "10px"
      };
      const result = css.raw(style);

      expect(result).toEqual({
        color: "red",
        fontSize: 16,
        padding: "10px"
      });
    });
  });

  describe.concurrent("css.multiple()", () => {
    it("Static Variants", () => {
      const result = css.multiple(
        {
          primary: { background: "blue" },
          secondary: { background: "aqua" }
        },
        debugId
      );

      assert.hasAllKeys(result, ["primary", "secondary"]);
      expect(result.primary).toMatch(identifierName(`${debugId}_primary`));
      expect(result.secondary).toMatch(identifierName(`${debugId}_secondary`));
    });

    it("Empty variants", () => {
      const result = css.multiple({}, debugId);

      assert.isEmpty(result);
      expect(Object.keys(result)).to.have.lengthOf(0);
    });

    it("Single variant", () => {
      const result = css.multiple(
        {
          primary: { background: "blue" }
        },
        debugId
      );

      assert.hasAllKeys(result, ["primary"]);
      expect(result.primary).toMatch(identifierName(`${debugId}_primary`));
    });
  });

  describe.concurrent("css.with()", () => {
    it("css.with() with type restrictions", () => {
      const myCss1 = css.with<{
        color: true;
        background: "blue" | "grey";
        border: false;
      }>();

      myCss1({
        color: "red", // Allow all properties
        background: "blue", // Only some properties are allowed
        // @ts-expect-error: border is not allowed
        border: "none"
      });
      myCss1({
        color: "red",
        // @ts-expect-error: background is allowed only "blue" or "grey"
        background: "red"
      });
      // @ts-expect-error: color is required
      myCss1({
        background: "blue"
      });
      // @ts-expect-error: background is required
      myCss1({
        color: "red"
      });

      const myCss2 = css.with<{ size: number; radius?: number }>();
      // @ts-expect-error: size is required
      myCss2.raw({ radius: 10 });
    });

    it("Basic callback transformation", () => {
      const withRedBackground = css.with((style) => ({
        ...style,
        backgroundColor: "red"
      }));

      const result = withRedBackground({ color: "blue" }, debugId);

      assert.isString(result);
      expect(result).toMatch(identifierName(debugId));
    });

    it("css.with().raw()", () => {
      const withRedBackground = css.with((style) => ({
        ...style,
        backgroundColor: "red"
      }));

      const result = withRedBackground.raw({ color: "blue" });

      expect(result).toEqual({
        color: "blue",
        backgroundColor: "red"
      });
    });

    it("css.with().multiple()", () => {
      const withRedBackground = css.with((style) => ({
        ...style,
        backgroundColor: "red"
      }));

      const result = withRedBackground.multiple(
        {
          primary: { color: "blue" },
          secondary: { color: "green" }
        },
        debugId
      );

      assert.hasAllKeys(result, ["primary", "secondary"]);
      expect(result.primary).toMatch(identifierName(`${debugId}_primary`));
      expect(result.secondary).toMatch(identifierName(`${debugId}_secondary`));
    });

    it("css.with() with like mixin", () => {
      const myCss = css.with<{ size: number; radius?: number }>(
        ({ size, radius = 10 }) => {
          const styles: CSSRule = {
            width: size,
            height: size
          };

          if (radius !== 0) {
            styles.borderRadius = radius;
          }

          return styles;
        }
      );

      expect(myCss.raw({ size: 100 })).toStrictEqual({
        width: 100,
        height: 100,
        borderRadius: 10
      });
      expect(myCss.raw({ size: 100, radius: 0 })).toStrictEqual({
        width: 100,
        height: 100
      });
      expect(myCss.raw({ size: 100, radius: 100 })).toStrictEqual({
        width: 100,
        height: 100,
        borderRadius: 100
      });
    });

    it("css.with() with like mixin for multiple", () => {
      const myCss = css.with<{ paletteColor: string }>(({ paletteColor }) => ({
        background: paletteColor
      }));
      const result = myCss.multiple(
        {
          primary: { paletteColor: "blue" },
          secondary: { paletteColor: "aqua" }
        },
        debugId
      );

      assert.hasAllKeys(result, ["primary", "secondary"]);
      expect(result.primary).toMatch(identifierName(`${debugId}_primary`));
      expect(result.secondary).toMatch(identifierName(`${debugId}_secondary`));
    });

    it("css.with() with composition", () => {
      const base = css({ padding: 12 }, "base");
      const myCss = css.with<{ paletteColor: string }>(({ paletteColor }) => [
        base,
        {
          background: paletteColor
        }
      ]);
      const result = myCss.multiple(
        {
          primary: { paletteColor: "blue" },
          secondary: { paletteColor: "aqua" }
        },
        debugId
      );

      assert.hasAllKeys(result, ["primary", "secondary"]);
      expect(result.primary).toMatch(
        identifierName(`${debugId}_primary`, "base")
      );
      expect(result.secondary).toMatch(
        identifierName(`${debugId}_secondary`, "base")
      );
    });

    it("css.with() with complex transformation", async () => {
      const colorPalette = {
        primary: { color: "blue", shade: "dark" },
        secondary: { color: "green", shade: "light" },
        accent: { color: "red", shade: "medium" }
      };

      // Define mapping function
      const myCSS = css.with<{ color: string; shade: string }>(
        ({ color, shade }) => ({
          background: color,
          opacity: shade === "dark" ? 0.8 : shade === "light" ? 0.4 : 0.6,
          borderColor: color
        })
      );

      // 1. Unit test for mapping function - verify each item is converted to correct style object
      const primaryStyle = myCSS.raw(colorPalette.primary);
      const secondaryStyle = myCSS.raw(colorPalette.secondary);
      const accentStyle = myCSS.raw(colorPalette.accent);

      // Validate transformed style objects
      expect(primaryStyle).toEqual({
        background: "blue",
        opacity: 0.8,
        borderColor: "blue"
      });

      expect(secondaryStyle).toEqual({
        background: "green",
        opacity: 0.4,
        borderColor: "green"
      });

      expect(accentStyle).toEqual({
        background: "red",
        opacity: 0.6,
        borderColor: "red"
      });

      // 2. Verify internal behavior of css.multiple with transform function mocking
      const transformSpy = vi.spyOn(
        await import("@mincho-js/transform-to-vanilla"),
        "transform"
      );

      const result = myCSS.multiple(colorPalette, debugId);

      // Verify that transform function was called with correct style objects
      expect(transformSpy).toHaveBeenCalledTimes(3);

      // Validate style objects passed in each call
      const transformCalls = transformSpy.mock.calls;
      expect(transformCalls[0][0]).toEqual(primaryStyle); // primary
      expect(transformCalls[1][0]).toEqual(secondaryStyle); // secondary
      expect(transformCalls[2][0]).toEqual(accentStyle); // accent

      // Test existing class name generation
      assert.hasAllKeys(result, ["primary", "secondary", "accent"]);
      expect(result.primary).toMatch(identifierName(`${debugId}_primary`));
      expect(result.secondary).toMatch(identifierName(`${debugId}_secondary`));
      expect(result.accent).toMatch(identifierName(`${debugId}_accent`));

      // Verify that each result is a valid CSS class name string
      expect(typeof result.primary).toBe("string");
      expect(typeof result.secondary).toBe("string");
      expect(typeof result.accent).toBe("string");

      // Verify that class names are not empty
      expect(result.primary.length).toBeGreaterThan(0);
      expect(result.secondary.length).toBeGreaterThan(0);
      expect(result.accent.length).toBeGreaterThan(0);

      // Verify that different class names are generated for each case (no duplicates)
      expect(result.primary).not.toBe(result.secondary);
      expect(result.secondary).not.toBe(result.accent);
      expect(result.primary).not.toBe(result.accent);

      // Clean up spy
      transformSpy.mockRestore();
    });
  });
}
