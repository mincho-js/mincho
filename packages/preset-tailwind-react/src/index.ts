import * as tailwind from "@mincho-js/preset-tailwind";
import { defineRules } from "@mincho-js/react";

export {
  contract,
  css,
  cx,
  preset,
  rules,
  themeClass,
  vars
} from "@mincho-js/preset-tailwind";

export const styled: ReturnType<typeof defineRules<typeof tailwind>>["styled"] =
  /* @__PURE__ */ (() => defineRules(tailwind).styled)();
