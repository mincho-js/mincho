import {
  transform,
  replaceVariantReference,
  initTransformContext
} from "@mincho-js/transform-to-vanilla";
import type {
  TransformContext,
  ComplexCSSRule,
  CSSRule
} from "@mincho-js/transform-to-vanilla";
import { style as vStyle } from "@vanilla-extract/css";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import { css, globalCss } from "./index.js";
import { identifierName, getDebugName } from "../utils.js";

/**
 * styleVariants - Vanilla Extract compatible API
 *
 * Supports both static collection and dynamic mapping variants.
 * This is the full-featured version maintained for Vanilla Extract compatibility.
 */
export function styleVariants<
  StyleMap extends Record<string | number, ComplexCSSRule>
>(styleMap: StyleMap, debugId?: string): Record<keyof StyleMap, string>;
export function styleVariants<
  Data extends Record<string | number, unknown>,
  MapData extends (value: Data[keyof Data], key: keyof Data) => ComplexCSSRule
>(data: Data, mapData: MapData, debugId?: string): Record<keyof Data, string>;
export function styleVariants<
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
    return processMultiple(data, mapData, debugId);
  } else {
    const styleMap = styleMapOrData as StyleMap;
    const debugId = mapDataOrDebugId;
    return processMultiple(styleMap, (style) => style, debugId);
  }
}

function isMapDataFunction<
  Data extends Record<string | number, unknown>,
  MapData extends (value: Data[keyof Data], key: keyof Data) => ComplexCSSRule
>(mapDataOrDebugId?: MapData | string): mapDataOrDebugId is MapData {
  return typeof mapDataOrDebugId === "function";
}

function processMultiple<T>(
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

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, assert, expect, vi } = import.meta.vitest;

  const debugId = "styleVariants";
  setFileScope("test-compat");

  describe.concurrent("styleVariants() - Compat API", () => {
    it("Static Variants", () => {
      const result = styleVariants(
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

    it("Mapping Variants - Simple", () => {
      const result = styleVariants(
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
      expect(result.primary).toMatch(identifierName(`${debugId}_primary`));
      expect(result.secondary).toMatch(identifierName(`${debugId}_secondary`));
    });

    it("Mapping Variants with composition", () => {
      const base = css({ padding: 12 }, "base");
      const result = styleVariants(
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
      expect(result.primary).toMatch(
        identifierName(`${debugId}_primary`, "base")
      );
      expect(result.secondary).toMatch(
        identifierName(`${debugId}_secondary`, "base")
      );
    });

    it("Complex composition with multiple base styles", () => {
      const base1 = css({ padding: 12 }, "base1");
      const base2 = css({ margin: 8 }, "base2");
      const result = styleVariants(
        {
          primary: [base1, base2, { background: "blue" }],
          secondary: [base1, { background: "aqua" }]
        },
        debugId
      );

      assert.hasAllKeys(result, ["primary", "secondary"]);
      expect(result.primary).toMatch(
        identifierName(`${debugId}_primary`, "base1", "base2")
      );
      expect(result.secondary).toMatch(
        identifierName(`${debugId}_secondary`, "base1")
      );
    });

    it("Empty variants", () => {
      const result = styleVariants({}, debugId);

      assert.isEmpty(result);
      expect(Object.keys(result)).to.have.lengthOf(0);
    });

    it("Single variant", () => {
      const result = styleVariants(
        {
          primary: { background: "blue" }
        },
        debugId
      );

      assert.hasAllKeys(result, ["primary"]);
      expect(result.primary).toMatch(identifierName(`${debugId}_primary`));
    });

    it("String class composition", () => {
      const baseClass = "existing-class";
      const result = styleVariants(
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

    it("Complex transformation with mapping", () => {
      const colorPalette = {
        primary: { color: "blue", shade: "dark" },
        secondary: { color: "green", shade: "light" },
        accent: { color: "red", shade: "medium" }
      };

      const result = styleVariants(
        colorPalette,
        ({ color, shade }) => ({
          background: color,
          opacity: shade === "dark" ? 0.8 : shade === "light" ? 0.4 : 0.6,
          borderColor: color
        }),
        debugId
      );

      assert.hasAllKeys(result, ["primary", "secondary", "accent"]);
      expect(result.primary).toMatch(identifierName(`${debugId}_primary`));
      expect(result.secondary).toMatch(identifierName(`${debugId}_secondary`));
      expect(result.accent).toMatch(identifierName(`${debugId}_accent`));
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

      const result = styleVariants(colorPalette, mappingFunction, debugId);

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
