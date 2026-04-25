import {
  defineRules,
  type CSSProperties,
  type DefineRulesPresetMap
} from "@mincho-js/css";

type SharedCssInput = Pick<
  CSSProperties,
  "background" | "color" | "padding" | "borderRadius" | "display"
>;

type SharedCss = (args: SharedCssInput) => string;

type SharedPreset = {
  schema: "mincho.defineRulesPreset";
  version: 3;
  classNameByCache: DefineRulesPresetMap;
};

type SharedPresetOwner = {
  css: SharedCss;
  preset: SharedPreset;
};

export const { css, preset }: SharedPresetOwner = defineRules({
  debugId: "sharedPreset",
  properties: {
    background: true,
    color: true,
    padding: true,
    borderRadius: true,
    display: true
  }
});

export const sharedCardClassName = css({
  background: "rebeccapurple",
  color: "white",
  padding: 16,
  borderRadius: 12,
  display: "block"
});
