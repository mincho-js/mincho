import {
  transform,
  replaceVariantReference,
  initTransformContext,
  type TransformContext
} from "@mincho-js/transform-to-vanilla";
import type {
  CSSProperties,
  ComplexCSSRule,
  GlobalCSSRule,
  CSSRule
} from "@mincho-js/transform-to-vanilla";
import { style as vStyle, globalStyle as gStyle } from "@vanilla-extract/css";
export type { Adapter, FileScope } from "@vanilla-extract/css";
export {
  assignVars,
  composeStyles,
  createContainer,
  createGlobalTheme,
  createGlobalThemeContract,
  createTheme,
  createThemeContract,
  createVar,
  fallbackVar,
  fontFace,
  generateIdentifier,
  globalFontFace,
  globalKeyframes,
  globalLayer,
  keyframes,
  layer
} from "@vanilla-extract/css";
export { rules } from "./rules";
export type { RulesVariants, RecipeVariants, RuntimeFn } from "./rules/types";

export type { CSSProperties, ComplexCSSRule, GlobalCSSRule, CSSRule };
export type ComplexStyleRule = ComplexCSSRule;
export type GlobalStyleRule = GlobalCSSRule;
export type StyleRule = CSSRule;

export function globalCss(selector: string, rule: GlobalCSSRule) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: error TS2345 Argument of type 'ComplexStyleRule' is not assignable to parameter of type 'GlobalStyleRule'
  gStyle(selector, transform(rule));
}
export const globalStyle = globalCss;

export function css(style: ComplexCSSRule, debugId?: string) {
  return vStyle(transform(style), debugId);
}
export const style = css;

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
      debugId ? `${debugId}_${key}` : key
    );
    contexts.push(context);
    variantMap[`%${key}`] = className;
    classMap[key] = className;
  }

  for (const context of contexts) {
    context.variantMap = variantMap;
    replaceVariantReference(context);
    for (const [key, value] of Object.entries(context.variantReference)) {
      globalCss(key, value as StyleRule);
    }
  }

  return classMap;
}
