import {
  internalAnalyzeRuntimeExpressions,
  internalApplyRuntimeExpressions
} from "@mincho-js/babel";
import { createRuntimeFn } from "@mincho-js/css/rules/createRuntimeFn";
import type {
  BabelTransformResult,
  BabelTransformSourceOptions,
  StaticCssEvalSourceProvider
} from "./babel.js";
import { driveModuleGraph } from "./moduleGraph.js";
import { cacheDigest } from "./compilationCache.js";
import {
  measureCompilationPhase,
  recordCompilationDiagnostic
} from "./diagnostics.js";

/** Per-generation observed arguments only. Never retain evaluated CSS or registry state here. */
export class RuntimeOptimizations {
  private readonly values = new Map<string, string>();

  clear(): void {
    this.values.clear();
  }

  async transform(
    options: BabelTransformSourceOptions,
    result: BabelTransformResult,
    provider: StaticCssEvalSourceProvider
  ): Promise<BabelTransformResult> {
    const optimize = options.babel?.optimize;
    if (
      optimize?.staticRecipes === false &&
      optimize.styledComponents === false
    )
      return result;

    const dependencies = new Set<string>();
    const analysis = await measureCompilationPhase("static-recipes", () =>
      driveModuleGraph(
        internalAnalyzeRuntimeExpressions({
          filename: options.filename,
          source: result.code,
          parserCache: options.babel?.compilationCache?.parser,
          pureFunctions: optimize?.pureFunctions,
          staticRecipes: optimize?.staticRecipes,
          styledComponents: optimize?.styledComponents
        }),
        provider,
        dependencies
      )
    ).catch(() => null);
    if (!analysis) return result;

    const replacements: Array<{ key: string; value: string }> = [];
    const elements: Array<{
      key: string;
      tag: string;
      variants: readonly string[];
      className: string;
    }> = [];

    const observed = [
      ...analysis.calls.map((call) => ({ call, element: undefined })),
      ...analysis.elements.map((element) => ({ call: element, element }))
    ];

    for (const { call, element } of observed) {
      // The implementation is the same pure runtime used by the serialized sidecar.
      // Configurations are literal data; no producer/component module is evaluated.
      const key = cacheDigest(
        JSON.stringify([call.identity, call.config, call.options])
      );

      let value = this.values.get(key);

      if (value === undefined) {
        try {
          const runtime = createRuntimeFn(
            call.config as Parameters<typeof createRuntimeFn>[0]
          );

          value = runtime(call.options as Parameters<typeof runtime>[0]);
        } catch {
          continue;
        }

        if (typeof value !== "string") continue;
        if (this.values.size < 4096) this.values.set(key, value);
      }

      if (element)
        elements.push({
          key: call.key,
          tag: element.tag,
          variants: element.variants,
          className: `${value} ${element.className}`
        });
      else replacements.push({ key: call.key, value });
    }

    recordCompilationDiagnostic("static-recipes-result", {
      folded: replacements.length,
      observed: this.values.size
    });
    recordCompilationDiagnostic("styled-components-result", {
      flattened: elements.length
    });

    if (!replacements.length && !elements.length) return result;

    const transformed = internalApplyRuntimeExpressions({
      filename: options.filename,
      source: result.code,
      replacements,
      elements,
      sourceMaps: options.sourceMaps,
      inputSourceMap: result.map ?? undefined
    });
    if (!transformed?.code) return result;

    for (const file of analysis.dependencies) dependencies.add(file);

    const previous = result.staticCssEval;

    return {
      ...result,
      code: transformed.code,
      ...(options.sourceMaps ? { map: transformed.map } : {}),
      runtimeOptimized: true,
      staticCssEval: {
        dependencies: [],
        diagnostics: [],
        cacheKeys: [],
        resolvedModuleIds: [],
        ownerToDependencies: new Map(),
        dependencyToOwners: new Map(),
        resolvedModuleCache: new Map(),
        resolvedDependencies: [],
        ...previous,
        dependencyFiles: [
          ...new Set([...(previous?.dependencyFiles ?? []), ...dependencies])
        ]
      }
    };
  }
}
