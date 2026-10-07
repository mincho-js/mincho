import type { BabelOptions } from "./babel.js";

export type OptimizationMode = "development" | "production";

/** Explicit switches override the profile; undefined never erases a switch. */
export function resolveOptimizationOptions(
  mode: OptimizationMode,
  ...overrides: Array<BabelOptions["optimize"]>
): NonNullable<BabelOptions["optimize"]> {
  const result: NonNullable<BabelOptions["optimize"]> = {
    pureFunctions: true,
    staticRecipes: mode === "production",
    styledComponents: mode === "production",
    runtimeCodegen: mode === "production",
    jsxRuntimeGuards: mode === "production"
  };

  for (const options of overrides)
    Object.assign(
      result,
      Object.fromEntries(
        Object.entries(options ?? {}).filter(([, value]) => value !== undefined)
      )
    );

  return result;
}
