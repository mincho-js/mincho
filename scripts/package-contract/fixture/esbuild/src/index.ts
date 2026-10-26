import { rules } from "@mincho-js/css";
import { rule as parentRule } from "@mincho-js-proof/diamond-a/rules";
import "@examples/shared-component/style.css";
import "@mincho-js-proof/diamond-a/style.css";
import "@mincho-js-proof/diamond-b/style.css";
import "@mincho-js-proof/diamond-c/style.css";
import "@mincho-js-proof/diamond-d/style.css";
export { card, extendedAtomic } from "./dynamic.css.js";
export const explicitStyleLoaded = true;

export const extendedRule = rules.extends(
  parentRule,
  {
    borderTopColor: "mediumseagreen",
    letterSpacing: 3,
    variants: { size: { small: { letterSpacing: 2 } } }
  },
  "extendedRule"
);
