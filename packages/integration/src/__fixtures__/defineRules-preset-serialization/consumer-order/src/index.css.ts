
import { defineRules } from "@mincho-js/css";
import { preset as primaryRootPreset } from "__DEFINE_RULES_PRESET_SPECIFIER__";
import { preset as secondaryRootPreset } from "__DEFINE_RULES_PRESET_SECONDARY_SPECIFIER__";

export const preset = defineRules({
  presets: {
    ...primaryRootPreset,
    ...secondaryRootPreset
  },
  properties: {
    color: true,
    display: true,
    padding: true,
    margin: true
  }
});

const { css } = preset;

export const overlapPrimaryFirst = css([
  {
    color: "rebeccapurple",
    display: "flex"
  },
  {
    padding: 13
  },
  {
    color: "tomato"
  }
]);

export const overlapSecondaryFirst = css([
  {
    color: "rebeccapurple",
    display: "flex"
  },
  {
    color: "tomato"
  },
  {
    padding: 13
  }
]);

export const overlapConsumerOnly = css({
  padding: 13,
  margin: 11
});
