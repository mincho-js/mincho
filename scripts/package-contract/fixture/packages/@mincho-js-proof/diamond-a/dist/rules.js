import { createRuntimeFn } from "@mincho-js/css/rules/createRuntimeFn";
import { createDefineRulesCssRuntime } from "@mincho-js/css/defineRules/createDefineRulesCssRuntime";
import { createDefineRulesCxRuntime } from "@mincho-js/css/defineRules/createDefineRulesCxRuntime";
import { preset } from "./preset.js";

export const rule = createRuntimeFn({
  defaultClassName: "extends_parent_base",
  variantClassNames: { size: { small: "extends_parent_small" } },
  defaultVariants: { size: "small" },
  compoundVariants: [],
  propVars: { width: "--extends_width" },
  classNameReferences: {
    base: "extends_parent_base",
    variants: { size: { small: "extends_parent_small" } }
  },
  extension: { version: 1, stylePackages: ["@mincho-js-proof/diamond-a"] }
});

export const definitions = {
  css: createDefineRulesCssRuntime({
    properties: { display: ["flex"], color: { brand: "steelblue" } },
    presets: preset
  }),
  cx: createDefineRulesCxRuntime({ classWrites: [["diamond_a_display", 1]] }),
  preset
};
