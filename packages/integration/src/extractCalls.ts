import {
  internalAnalyzeExtractCalls,
  internalCanonicalExtractCallsFile,
  type InternalPreparedExtractCalls
} from "@mincho-js/babel";
import type { StaticCssEvalSourceProvider } from "./babel.js";
import { driveModuleGraph } from "./moduleGraph.js";

export async function prepareExtractCalls(
  options: Parameters<typeof internalAnalyzeExtractCalls>[0],
  provider?: StaticCssEvalSourceProvider
): Promise<InternalPreparedExtractCalls> {
  const watchFiles = new Set<string>();
  const analysis = internalAnalyzeExtractCalls({
    ...options,
    filename: internalCanonicalExtractCallsFile(options.filename)
  });

  const prepared = await driveModuleGraph(analysis, provider, watchFiles);

  return {
    ...prepared,
    dependencies: [...new Set([...prepared.dependencies, ...watchFiles])].sort()
  };
}
