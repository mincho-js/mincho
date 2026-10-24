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
    jsxRuntimeGuards: mode === "production",

    // These evaluation shortcuts need an explicit opt-in: cost varies by workload.
    compactRuntime: false,
    compactMetadata: false,
    sizeAware: false,
    dependencyGraph: false,
    staticStyles: false,
    staticScopedCx: false,
    symbolicTokens: false
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
