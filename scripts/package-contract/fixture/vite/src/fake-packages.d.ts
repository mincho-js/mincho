declare module "@mincho-js-proof/diamond-d" {
  export const local: "diamond_d_padding";
}

declare module "@mincho-js-proof/diamond-d/preset" {
  import type { DefineRulesPresetInput } from "@mincho-js/css";

  export const preset: DefineRulesPresetInput;
}

declare module "@mincho-js-proof/diamond-a/rules" {
  import type { RuntimeFn } from "@mincho-js/css";
  export const rule: RuntimeFn<
    { size: { small: { letterSpacing: 1 } } },
    ["width"]
  >;
}
