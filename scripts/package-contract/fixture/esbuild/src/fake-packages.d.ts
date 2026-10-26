declare module "@mincho-js-proof/diamond-d/preset" {
  import type { DefineRulesPresetInput } from "@mincho-js/css";

  export const preset: DefineRulesPresetInput;
}

declare module "@mincho-js-proof/diamond-a/rules" {
  import type { DefineRulesRuntimeResult, RuntimeFn } from "@mincho-js/css";
  export const rule: RuntimeFn<
    { size: { small: { letterSpacing: 1 } } },
    ["width"]
  >;
  export const definitions: DefineRulesRuntimeResult<
    { display: readonly ["flex"]; color: { brand: "steelblue" } },
    Record<never, never>
  >;
}
