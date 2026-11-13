import { createHash } from "node:crypto";
import { analyzeExtractCalls } from "../extractionCalls/analysis.js";
import type { ExtractCalls } from "../types.js";
import type { ModuleGraphResponse } from "../moduleGraph.js";

/** Virtual source-provider fixture: source text is analyzed, never a manual proof. */
export function prepareModuleSourceFixture(
  source: string,
  modules: Readonly<Record<string, string>>,
  extractCalls: ExtractCalls,
  observeRuntime = false
) {
  const ids = new Map(
    Object.keys(modules).map((name) => [name, `/fixture/${name}.ts`])
  );
  const sources = new Map(
    Object.entries(modules).map(([name, body]) => [ids.get(name)!, body])
  );
  const flow = analyzeExtractCalls({
    source,
    extractCalls,
    root: "/fixture",
    filename: "/fixture/entry.ts",
    jsx: true
  });
  let step = flow.next();
  while (!step.done) {
    const request = step.value;
    const loaded =
      request.kind === "load" ? sources.get(request.id) : undefined;
    const response: ModuleGraphResponse =
      request.kind === "resolve"
        ? (ids.get(request.source) ?? null)
        : request.kind === "load"
          ? observeRuntime &&
            request.purpose === "consumer-runtime" &&
            loaded !== undefined
            ? {
                source: loaded,
                sourceHash: createHash("sha256").update(loaded).digest("hex"),
                version: "fixture-runtime:1",
                watchFiles: []
              }
            : (loaded ?? null)
          : null;
    step = flow.next(response);
  }
  return step.value;
}
