import { transform } from "@mincho-js/transform-to-vanilla";
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
  Key extends keyof Data
>(
  data: Data,
  mapData: (value: Data[Key], key: Key) => ComplexCSSRule,
  debugId?: string
): Record<keyof Data, string>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cssVariants(...args: any[]) {
  if (typeof args[1] === "function") {
    const data = args[0];
    const mapData = args[1];
    const debugId = args[2];

    const classMap: Record<string | number, string> = {};
    for (const key in data) {
      classMap[key] = css(
        mapData(data[key], key),
        debugId ? `${debugId}_${key}` : key
      );
    }

    return classMap;
  }

  const styleMap = args[0];
  const debugId = args[1];

  const classMap: Record<string | number, string> = {};
  for (const key in styleMap) {
    classMap[key] = css(styleMap[key], debugId ? `${debugId}_${key}` : key);
  }

  return classMap;
}
export const styleVariants = cssVariants;
