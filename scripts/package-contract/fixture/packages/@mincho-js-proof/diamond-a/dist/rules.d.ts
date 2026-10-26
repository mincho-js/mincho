import type { DefineRulesRuntimeResult, RuntimeFn } from "@mincho-js/css";

export declare const rule: RuntimeFn<
  { size: { small: { letterSpacing: 1 } } },
  ["width"]
>;
export declare const definitions: DefineRulesRuntimeResult<
  { display: readonly ["flex"]; color: { brand: "steelblue" } },
  Record<never, never>
>;
