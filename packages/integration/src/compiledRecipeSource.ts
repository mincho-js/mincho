import { internalApplyRuntimeExpressions } from "@mincho-js/babel";
import type { BabelOptions } from "./babel.js";
import { preferRuntimeCandidate } from "./bundleSize.js";
import { recordCompilationDiagnostic } from "./diagnostics.js";

/** Serialization produces immutable factories after the authoring Babel pass. */
export async function optimizeCompiledRecipeSource(
  source: string,
  filename: string,
  options: Pick<BabelOptions, "optimize" | "bundleSize">
): Promise<string> {
  if (!options.optimize?.compactRuntime && !options.optimize?.compactMetadata)
    return source;
  const output = internalApplyRuntimeExpressions({
    source,
    replacements: [],
    filename,
    compactRuntime: options.optimize.compactRuntime,
    compactMetadata: options.optimize.compactMetadata,
    bundleSize: options.bundleSize
  });
  if (!output?.code || output.code === source) return source;
  if (options.optimize.sizeAware || options.optimize.compactMetadata) {
    try {
      const result = await preferRuntimeCandidate(
        source,
        output.code,
        filename,
        options.bundleSize
      );
      recordCompilationDiagnostic("bundle-size-serialized-recipe", {
        ...result,
        estimate: true
      });
      return result.applied ? output.code : source;
    } catch {
      recordCompilationDiagnostic("bundle-size-serialized-recipe", {
        applied: false,
        reason: "unmeasurable-helper-graph"
      });
      return source;
    }
  }
  return output.code;
}
