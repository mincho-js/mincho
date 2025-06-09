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

export const css = Object.assign(cssImpl, {
  raw: cssRaw,
  multiple: cssVariants
});

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
      const base = css({ padding: 12 }, "base");
      const result = css([base, { color: "red" }], debugId);

      assert.isString(result);
      expect(result).toMatch(className(debugId, "base"));
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

    // TODO: Mocking globalCSS() for Variant Reference
  });
}
