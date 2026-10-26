import { rules } from "@mincho-js/css";
import { rule as parentRule } from "@mincho-js-proof/diamond-a/rules";

export { staticCx, extendedAtomic } from "./static.css.js";

export const extendedRule = rules.extends(
  parentRule,
  {
    borderTopColor: "mediumseagreen",
    letterSpacing: 3,
    variants: { size: { small: { letterSpacing: 2 } } }
  },
  "extendedRule"
);
