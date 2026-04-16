
import { defineRules } from "@mincho-js/css";
import { preset as rootPreset } from "__DEFINE_RULES_PRESET_SPECIFIER__";

export const preset = defineRules({
  presets: rootPreset,
  properties: {
    color: true,
    display: true,
    padding: true,
    margin: true
  }
});

const { css } = preset;

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});

export const producerOnly = css({
  padding: 13,
  margin: 11
});
