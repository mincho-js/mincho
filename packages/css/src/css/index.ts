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

import { className, getDebugName } from "../utils";

// == Global CSS ===============================================================
export function globalCss(selector: string, rule: GlobalCSSRule) {
  gStyle(selector, transform(rule));
}
export const globalStyle = globalCss;

// == CSS ======================================================================
export function css(style: ComplexCSSRule, debugId?: string) {
  return vStyle(transform(style), debugId);
}
export const style = css;

// == CSS Variants =============================================================
// TODO: Need to optimize
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions/get#smart_self-overwriting_lazy_getters
// https://github.com/vanilla-extract-css/vanilla-extract/blob/master/packages/css/src/style.ts
export function cssVariants<
  StyleMap extends Record<string | number, ComplexCSSRule>
>(styleMap: StyleMap, debugId?: string): Record<keyof StyleMap, string>;
export function cssVariants<
  Data extends Record<string | number, unknown>,
  Key extends keyof Data,
  MapData extends (value: Data[Key], key: Key) => ComplexCSSRule
>(data: Data, mapData: MapData, debugId?: string): Record<keyof Data, string>;
export function cssVariants<
  StyleMap extends Record<string | number, ComplexCSSRule>,
  Data extends Record<string | number, unknown>,
  MapData extends (value: unknown, key: string | number) => ComplexCSSRule
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
export const styleVariants = cssVariants;

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
  const { describe, it, assert, expect } = import.meta.vitest;

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
      const base = style({ padding: 12 }, "base");
      const result = css([base, { color: "red" }], debugId);

      assert.isString(result);
      expect(result).toMatch(className(debugId, "base"));
    });
  });

  describe.concurrent("cssVariants()", () => {
    it("Variants", () => {
      const result = cssVariants(
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
      const result = cssVariants(
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
      const base = style({ padding: 12 }, "base");
      const result = cssVariants(
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

    // TODO: Mocking globalCSS() for Variant Reference
  });
}
