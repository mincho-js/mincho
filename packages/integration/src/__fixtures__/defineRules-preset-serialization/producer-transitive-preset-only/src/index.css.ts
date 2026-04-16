
import { defineRules } from "@mincho-js/css";
import { preset as importedPreset } from "__DEFINE_RULES_PRESET_SPECIFIER__";

export const preset = defineRules({
  presets: importedPreset,
  properties: {
    color: true,
    display: true,
    padding: true,
    margin: true
  }
});

const { css } = preset;
