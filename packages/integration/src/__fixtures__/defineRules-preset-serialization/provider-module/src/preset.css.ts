
import {
  defineRules,
  type CSSProperties
} from "@mincho-js/css";

type SharedCss = ((args: unknown) => string) & {
  raw: (args: unknown) => CSSProperties;
};

export const sharedPreset = defineRules({
  debugId: "provider-module",
  properties: {
    color: true,
    display: true
  }
});

export const preset = sharedPreset;

export const { css: sharedCss } = sharedPreset as unknown as {
  css: SharedCss;
};

export const css = sharedCss;
