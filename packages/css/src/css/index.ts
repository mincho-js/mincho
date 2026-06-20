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

type CssWithStyleResult<T extends CSSRule> = ((
  style: CSSRuleWith<T>,
  debugId?: string
) => string) & {
  raw(style: CSSRuleWith<T>): ComplexCSSRule;
  multiple<StyleMap extends Record<string | number, CSSRuleWith<T>>>(
    styleMap: StyleMap,
    debugId?: string
  ): Record<keyof StyleMap, string>;
};

type CssWithCallback = (...args: never[]) => ComplexCSSRule;

type CssWithCallbackArgs<F extends CssWithCallback> = Parameters<F>;

type IsMultiArgCallback<F extends CssWithCallback> =
  2 extends CssWithCallbackArgs<F>["length"] ? F : never;

type CssWithTupleValue<Args extends unknown[]> = Args | readonly [...Args];

type CssWithMixinResult<Args extends unknown[]> = ((
  ...args: Args
) => string) & {
  raw(...args: Args): ComplexCSSRule;
  multiple<StyleMap extends Record<string | number, CssWithTupleValue<Args>>>(
    styleMap: StyleMap,
    debugId?: string
  ): Record<keyof StyleMap, string>;
};

function cssWith<const T extends CSSRule>(): CssWithStyleResult<T>;
function cssWith<const T extends CSSRule>(
  callback: (style: CSSRuleWith<T>) => ComplexCSSRule
): CssWithStyleResult<T>;
function cssWith<const F extends CssWithCallback>(
  callback: F & IsMultiArgCallback<F>
): CssWithMixinResult<CssWithCallbackArgs<F>>;
function cssWith<const T extends CSSRule, const F extends CssWithCallback>(
  callback?:
    | ((style: CSSRuleWith<T>) => ComplexCSSRule)
    | (F & IsMultiArgCallback<F>)
): CssWithStyleResult<T> & CssWithMixinResult<CssWithCallbackArgs<F>> {
  type RestrictedCSSRule = CSSRuleWith<T>;
  type CssWithRuntimeCallback = (...args: unknown[]) => ComplexCSSRule;
  const cssFunction = (callback ??
    ((style: RestrictedCSSRule) => style)) as CssWithRuntimeCallback;

  function getCssWithDebugId(args: readonly unknown[]) {
    // Legacy object-first calls keep runtime debug-label precedence: an object-first
    // positional mixin still receives both args, but may use the second string as
    // the compatibility debug label. Positional mixin direct debug IDs are not a public typed API.
    return args.length === 2 &&
      typeof args[1] === "string" &&
      typeof args[0] === "object" &&
      args[0] !== null &&
      !Array.isArray(args[0])
      ? args[1]
      : undefined;
  }

  function cssWithImpl(...args: unknown[]) {
    return cssImpl(cssFunction(...args), getCssWithDebugId(args));
  }
  function cssWithRaw(...args: unknown[]) {
    return cssRaw(cssFunction(...args));
  }

  function cssWithMultiple<
    StyleMap extends Record<
      string | number,
      RestrictedCSSRule | CssWithTupleValue<CssWithCallbackArgs<F>>
    >
  >(styleMap: StyleMap, debugId?: string): Record<keyof StyleMap, string> {
    type TransformedStyleMap = Record<keyof StyleMap, ComplexCSSRule>;
    const transformedStyleMap: TransformedStyleMap = {} as TransformedStyleMap;
    for (const key in styleMap) {
      const value = styleMap[key];
      transformedStyleMap[key] = Array.isArray(value)
        ? cssFunction(...value)
        : cssFunction(value);
    }
    return cssMultiple(transformedStyleMap, debugId);
  }

  return Object.assign(cssWithImpl, {
    raw: cssWithRaw,
    multiple: cssWithMultiple
  }) as CssWithStyleResult<T> & CssWithMixinResult<CssWithCallbackArgs<F>>;
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
  const { describe, it, assert, expect, expectTypeOf, vi } = import.meta.vitest;

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

    it("css.with() overload type regressions", () => {
      const restrictedCss = css.with<{ color: true; border: false }>();

      restrictedCss({ color: "red" }, debugId);
      restrictedCss.raw({ color: "red" });
      restrictedCss.multiple({ primary: { color: "red" } }, debugId);
      // @ts-expect-error: color is required
      restrictedCss({});
      // @ts-expect-error: color is required
      restrictedCss.raw({});
      restrictedCss({
        color: "red",
        // @ts-expect-error: border is not included in the restriction
        border: "none"
      });

      const objectParamMixin = css.with<{ size: number }>(({ size }) => ({
        width: size
      }));

      objectParamMixin({ size: 12 }, debugId);
      objectParamMixin.raw({ size: 12 });
      objectParamMixin.multiple({ sm: { size: 12 } }, debugId);
      // @ts-expect-error: size is required
      objectParamMixin.raw({});

      const positionalMixin = css.with((size: number, radius?: number) => ({
        width: size,
        height: size,
        ...(radius === undefined ? {} : { borderRadius: radius })
      }));

      expectTypeOf<Parameters<typeof positionalMixin>>().toEqualTypeOf<
        [size: number, radius?: number]
      >();
      expectTypeOf<Parameters<typeof positionalMixin.raw>>().toEqualTypeOf<
        [size: number, radius?: number]
      >();
      expectTypeOf<
        ReturnType<typeof positionalMixin>
      >().toEqualTypeOf<string>();
      expectTypeOf<
        ReturnType<typeof positionalMixin.raw>
      >().toEqualTypeOf<ComplexCSSRule>();

      const runTypeOnlyCalls: boolean = false;
      if (runTypeOnlyCalls) {
        positionalMixin(12);
        positionalMixin(12, 4);
        positionalMixin.raw(12);
        positionalMixin.raw(12, 4);
        const result = positionalMixin.multiple(
          {
            sm: [12],
            md: [16, 4],
            lg: [24, 8] as const
          },
          debugId
        );
        expectTypeOf(result).toEqualTypeOf<{
          sm: string;
          md: string;
          lg: string;
        }>();

        // @ts-expect-error: one-argument positional mixins are not introduced
        css.with((size: number) => ({ width: size }));
        // @ts-expect-error: direct positional mixin calls do not accept object style args
        positionalMixin({ size: 12 });
        // @ts-expect-error: raw positional mixin calls do not accept object style args
        positionalMixin.raw({ size: 12 });
        // @ts-expect-error: multiple positional mixin maps require tuple values
        positionalMixin.multiple({ sm: { size: 12 } });
        // @ts-expect-error: multiple positional mixin maps require the first tuple element
        positionalMixin.multiple({ xs: [] });
        // @ts-expect-error: multiple positional mixin maps reject extra tuple elements
        positionalMixin.multiple({ xl: [24, 8, 2] });
        // @ts-expect-error: multiple positional mixin maps reject invalid tuple element types
        positionalMixin.multiple({ bad: ["large", 8] });
        // @ts-expect-error: direct positional mixin calls do not expose debugId args
        positionalMixin(12, debugId);
      }
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

    it("css.with().raw() forwards positional callback args", () => {
      const mixin = css.with((size: number, radius?: number) => ({
        width: size,
        height: size,
        borderRadius: radius ?? 0
      }));

      const result = mixin.raw(100, 8);

      expect(result).toEqual({
        width: 100,
        height: 100,
        borderRadius: 8
      });
    });

    it("css.with() forwards direct and raw string args without positional debug labels", () => {
      const callback = vi.fn((color: string, size: string) => ({
        color,
        fontFamily: size
      }));
      const mixin = css.with(callback);

      const result = mixin("red", "lg");
      const rawResult = mixin.raw("red", "lg");

      expect(callback).toHaveBeenNthCalledWith(1, "red", "lg");
      expect(callback).toHaveBeenNthCalledWith(2, "red", "lg");
      expect(result).not.toMatch(identifierName("lg"));
      expect(rawResult).toEqual({
        color: "red",
        fontFamily: "lg"
      });
    });

    it("css.with() preserves object-first debug labels while forwarding both args", () => {
      const callback = vi.fn((style: { color: string }, label: string) => ({
        ...style,
        fontFamily: label
      }));
      const mixin = css.with(callback);

      const result = mixin({ color: "red" }, "lg");

      expect(callback).toHaveBeenCalledWith({ color: "red" }, "lg");
      expect(result).toMatch(identifierName("lg"));
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

    it("css.with().multiple() forwards tuple map values as positional args", () => {
      const callback = vi.fn((size: number, label: string) => ({
        width: size,
        height: size,
        fontFamily: label
      }));
      const mixin = css.with(callback);

      const result = mixin.multiple(
        {
          sm: [12, "sm"],
          lg: [20, "lg"]
        } as const,
        debugId
      );

      assert.hasAllKeys(result, ["sm", "lg"]);
      expect(result.sm).toMatch(identifierName(`${debugId}_sm`));
      expect(result.lg).toMatch(identifierName(`${debugId}_lg`));
      expect(callback.mock.calls).toEqual([
        [12, "sm"],
        [20, "lg"]
      ]);
    });

    it("css.with().multiple() forwards optional tuple elements", () => {
      const callback = vi.fn((size: number, radius?: number) => ({
        width: size,
        height: size,
        borderRadius: radius ?? 0
      }));
      const mixin = css.with(callback);

      const result = mixin.multiple(
        {
          compact: [8]
        } as const,
        debugId
      );

      assert.hasAllKeys(result, ["compact"]);
      expect(result.compact).toMatch(identifierName(`${debugId}_compact`));
      expect(callback.mock.calls).toEqual([[8]]);
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
