import { createRuntimeFn } from "@mincho-js/css/rules/createRuntimeFn";

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
