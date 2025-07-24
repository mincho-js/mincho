import {
  transform,
  replaceVariantReference,
  initTransformContext
} from "@mincho-js/transform-to-vanilla";
import type {
  TransformContext,
  CSSRule,
  ComplexCSSRule,
  GlobalCSSRule
} from "@mincho-js/transform-to-vanilla";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import { style as vStyle, globalStyle as gStyle } from "@vanilla-extract/css";
import type { GlobalStyleRule } from "@vanilla-extract/css";
import { className, getDebugName } from "../utils.js";
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

// TODO: Make more type-safe
type UnknownObject = Record<string, unknown>;
type CSSRuleMap = Record<string, CSSRule>;
interface HoistResult {
  selectors: CSSRuleMap;
}

function hoistSelectors(input: CSSRule): HoistResult {
  const result: HoistResult = {
    selectors: {}
  };

  function processAtRules(obj: UnknownObject, path: string[] = []) {
    for (const key in obj) {
      if (key === "selectors") {
        // Hoist each selector when selectors are found
        const selectors = obj[key] as CSSRuleMap;
        for (const selector in selectors) {
          if (!result.selectors[selector]) {
            result.selectors[selector] = {};
          }

          // Create nested object structure based on current path
          let current = result.selectors[selector] as UnknownObject;
          for (let i = 0; i < path.length; i += 2) {
            const atRule = path[i];
            const condition = path[i + 1];

            if (!current[atRule]) {
              current[atRule] = {};
            }
            const atRuleObj = current[atRule] as UnknownObject;
            if (!atRuleObj[condition]) {
              atRuleObj[condition] = {};
            }

            current = atRuleObj[condition] as UnknownObject;
          }

          // Copy style properties
          Object.assign(current, selectors[selector]);
        }
      } else if (typeof obj[key] === "object" && obj[key] !== null) {
        // at-rule found (e.g: @media, @supports)
        const atRules = obj[key] as UnknownObject;
        for (const condition in atRules) {
          // Add current at-rule and condition to path and recursively call
          processAtRules(atRules[condition] as UnknownObject, [
            ...path,
            key,
            condition
          ]);
        }
      }
    }
  }

  processAtRules(input as UnknownObject);
  return result;
}

// == CSS ======================================================================
export function cssImpl(style: ComplexCSSRule, debugId?: string) {
  return vStyle(transform(style), debugId);
}

function cssRaw(style: ComplexCSSRule) {
  return style;
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

  function cssWithVariants<
    StyleMap extends Record<string | number, RestrictedCSSRule>
  >(styleMap: StyleMap, debugId?: string): Record<keyof StyleMap, string>;
  function cssWithVariants<
    Data extends Record<string | number, RestrictedCSSRule>,
    Key extends keyof Data,
    MapData extends (value: Data[Key], key: Key) => ComplexCSSRule
  >(data: Data, mapData: MapData, debugId?: string): Record<keyof Data, string>;
  function cssWithVariants<
    Data extends Record<string | number, RestrictedCSSRule>,
    MapData extends (
      value: unknown,
      key: string | number | symbol
    ) => ComplexCSSRule
  >(
    styleMapOrData: Data,
    mapDataOrDebugId?: MapData | string,
    debugId?: string
  ): Record<string | number, string> {
    if (isMapDataFunction(mapDataOrDebugId)) {
      return cssMultiple(
        styleMapOrData,
        (value, key) => mapDataOrDebugId(cssFunction(value), key),
        debugId
      );
    } else {
      return cssMultiple(styleMapOrData, cssFunction, mapDataOrDebugId);
    }
  }

  return Object.assign(cssWithImpl, {
    raw: cssWithRaw,
    multiple: cssWithVariants
  });
}

export const css = Object.assign(cssImpl, {
  raw: cssRaw,
  multiple: cssMultiple,
  with: cssWith
});

// == CSS Variants =============================================================
// TODO: Need to optimize
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions/get#smart_self-overwriting_lazy_getters
// https://github.com/vanilla-extract-css/vanilla-extract/blob/master/packages/css/src/style.ts
export function cssMultiple<
  StyleMap extends Record<string | number, ComplexCSSRule>
>(styleMap: StyleMap, debugId?: string): Record<keyof StyleMap, string>;
export function cssMultiple<
  Data extends Record<string | number, unknown>,
  Key extends keyof Data,
  MapData extends (value: Data[Key], key: Key) => ComplexCSSRule
>(data: Data, mapData: MapData, debugId?: string): Record<keyof Data, string>;
export function cssMultiple<
  StyleMap extends Record<string | number, ComplexCSSRule>,
  Data extends Record<string | number, unknown>,
  MapData extends (
    value: unknown,
    key: string | number | symbol
  ) => ComplexCSSRule
>(
  styleMapOrData: StyleMap | Data,
  mapDataOrDebugId?: MapData | string,
  debugId?: string
): Record<string | number, string> {
  if (isMapDataFunction(mapDataOrDebugId)) {
    const data = styleMapOrData as Data;
    const mapData = mapDataOrDebugId;
    return processVariants(data, mapData, debugId);
  } else {
    const styleMap = styleMapOrData as StyleMap;
    const debugId = mapDataOrDebugId;
    return processVariants(styleMap, (style) => style, debugId);
  }
}

function isMapDataFunction<
  Data extends Record<string | number, unknown>,
  Key extends keyof Data,
  MapData extends (value: Data[Key], key: Key) => ComplexCSSRule
>(mapDataOrDebugId?: MapData | string): mapDataOrDebugId is MapData {
  return typeof mapDataOrDebugId === "function";
}
function processVariants<T>(
  items: Record<string | number, T>,
  transformItem: (item: T, key: string | number) => ComplexCSSRule,
  debugId?: string
): Record<string | number, string> {
  const contexts: TransformContext[] = [];
  const variantMap: Record<string, string> = {};
  const classMap: Record<string | number, string> = {};

  for (const key in items) {
    const context = structuredClone(initTransformContext);
    const className = vStyle(
      transform(transformItem(items[key], key), context),
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

  describe.concurrent("css()", () => {
    it("className", () => {
      // myCSS__[HASH]
      const result = css({ color: "red" }, debugId);

      assert.isString(result);
      expect(result).toMatch(className(debugId));
    });

    it("composition", () => {
      const base = css({ padding: 12 }, "base");
      const result = css([base, { color: "red" }], debugId);

      assert.isString(result);
      expect(result).toMatch(className(debugId, "base"));
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
    it("Variants", () => {
      const result = css.multiple(
        {
          primary: { background: "blue" },
          secondary: { background: "aqua" }
        },
        debugId
      );

      assert.hasAllKeys(result, ["primary", "secondary"]);
      expect(result.primary).toMatch(className(`${debugId}_primary`));
      expect(result.secondary).toMatch(className(`${debugId}_secondary`));
    });

    it("Mapping Variants", () => {
      const result = css.multiple(
        {
          primary: "blue",
          secondary: "aqua"
        },
        (paletteColor) => ({
          background: paletteColor
        }),
        debugId
      );

      assert.hasAllKeys(result, ["primary", "secondary"]);
      expect(result.primary).toMatch(className(`${debugId}_primary`));
      expect(result.secondary).toMatch(className(`${debugId}_secondary`));
    });

    it("Mapping Variants with composition", () => {
      const base = css({ padding: 12 }, "base");
      const result = css.multiple(
        {
          primary: "blue",
          secondary: "aqua"
        },
        (paletteColor) => [
          base,
          {
            background: paletteColor
          }
        ],
        debugId
      );

      assert.hasAllKeys(result, ["primary", "secondary"]);
      expect(result.primary).toMatch(className(`${debugId}_primary`, "base"));
      expect(result.secondary).toMatch(
        className(`${debugId}_secondary`, "base")
      );
    });

    // Additional comprehensive test cases for css.multiple()
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
      expect(result.primary).toMatch(className(`${debugId}_primary`));
    });

    it("Complex composition with multiple base styles", () => {
      const base1 = css({ padding: 12 }, "base1");
      const base2 = css({ margin: 8 }, "base2");
      const result = css.multiple(
        {
          primary: [base1, base2, { background: "blue" }],
          secondary: [base1, { background: "aqua" }]
        },
        debugId
      );

      assert.hasAllKeys(result, ["primary", "secondary"]);
      expect(result.primary).toMatch(
        className(`${debugId}_primary`, "base1", "base2")
      );
      expect(result.secondary).toMatch(
        className(`${debugId}_secondary`, "base1")
      );
    });

    it("String class composition", () => {
      const baseClass = "existing-class";
      const result = css.multiple(
        {
          primary: [baseClass, { background: "blue" }],
          secondary: [baseClass, { background: "aqua" }]
        },
        debugId
      );

      assert.hasAllKeys(result, ["primary", "secondary"]);
      // String classes get composed into the final class name
      expect(result.primary).to.include(`${debugId}_primary`);
      expect(result.primary).to.include("existing-class");
      expect(result.secondary).to.include(`${debugId}_secondary`);
      expect(result.secondary).to.include("existing-class");
    });

    it("Mapping with complex transformation", () => {
      const colorPalette = {
        primary: { color: "blue", shade: "dark" },
        secondary: { color: "green", shade: "light" },
        accent: { color: "red", shade: "medium" }
      };

      const result = css.multiple(
        colorPalette,
        ({ color, shade }) => ({
          background: color,
          opacity: shade === "dark" ? 0.8 : shade === "light" ? 0.4 : 0.6,
          borderColor: color
        }),
        debugId
      );

      assert.hasAllKeys(result, ["primary", "secondary", "accent"]);
      expect(result.primary).toMatch(className(`${debugId}_primary`));
      expect(result.secondary).toMatch(className(`${debugId}_secondary`));
      expect(result.accent).toMatch(className(`${debugId}_accent`));
    });

    it("Mapping with complex transformation", async () => {
      const colorPalette = {
        primary: { color: "blue", shade: "dark" },
        secondary: { color: "green", shade: "light" },
        accent: { color: "red", shade: "medium" }
      };

      // Define mapping function
      const mappingFunction = ({
        color,
        shade
      }: {
        color: string;
        shade: string;
      }) => ({
        background: color,
        opacity: shade === "dark" ? 0.8 : shade === "light" ? 0.4 : 0.6,
        borderColor: color
      });

      // 1. Unit test for mapping function - verify each item is converted to correct style object
      const primaryStyle = mappingFunction(colorPalette.primary);
      const secondaryStyle = mappingFunction(colorPalette.secondary);
      const accentStyle = mappingFunction(colorPalette.accent);

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

      const result = css.multiple(colorPalette, mappingFunction, debugId);

      // Verify that transform function was called with correct style objects
      expect(transformSpy).toHaveBeenCalledTimes(3);

      // Validate style objects passed in each call
      const transformCalls = transformSpy.mock.calls;
      expect(transformCalls[0][0]).toEqual(primaryStyle); // primary
      expect(transformCalls[1][0]).toEqual(secondaryStyle); // secondary
      expect(transformCalls[2][0]).toEqual(accentStyle); // accent

      // Test existing class name generation
      assert.hasAllKeys(result, ["primary", "secondary", "accent"]);
      expect(result.primary).toMatch(className(`${debugId}_primary`));
      expect(result.secondary).toMatch(className(`${debugId}_secondary`));
      expect(result.accent).toMatch(className(`${debugId}_accent`));

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
      expect(result).toMatch(className(debugId));
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
      expect(result.primary).toMatch(className(`${debugId}_primary`));
      expect(result.secondary).toMatch(className(`${debugId}_secondary`));
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
  });
}
