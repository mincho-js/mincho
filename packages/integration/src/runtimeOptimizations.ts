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
import { cacheDigest, type CompilationCache } from "./compilationCache.js";
import {
  measureCompilationPhase,
  recordCompilationDiagnostic
} from "./diagnostics.js";

type Observation =
  | {
      kind: "resolve";
      args: Parameters<StaticCssEvalSourceProvider["resolve"]>;
      digest: string;
    }
  | {
      kind: "load";
      args: Parameters<StaticCssEvalSourceProvider["load"]>;
      digest: string;
    };

function digest(value: unknown): string {
  return cacheDigest(JSON.stringify(value) ?? "undefined");
}

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
      (optimize?.staticRecipes === false &&
        optimize.styledComponents === false) ||
      (result.runtimeCandidates &&
        (!result.runtimeCandidates.recipes ||
          optimize?.staticRecipes === false) &&
        (!result.runtimeCandidates.styled ||
          optimize?.styledComponents === false))
    ) {
      recordCompilationDiagnostic("runtime-analysis-skipped", {
        file: options.filename
      });

      return result;
    }

    const cache = options.babel?.compilationCache;

    return cache
      ? cache.withInputs(() =>
          this.cachedTransform(cache, options, result, provider)
        )
      : this.prepare(options, result, provider, () => {});
  }

  private async cachedTransform(
    cache: CompilationCache,
    options: BabelTransformSourceOptions,
    result: BabelTransformResult,
    provider: StaticCssEvalSourceProvider
  ): Promise<BabelTransformResult> {
    const key =
      "runtime:" +
      digest([
        options.filename,
        result.code,
        result.map,
        options.sourceMaps,
        options.babel?.optimize,
        options.babel?.compilationContext,
        result.staticCssEval?.dependencyFiles
      ]);

    const cached = await cache.run(
      key,
      async () => {
        const observations: Observation[] = [];
        let cacheable = true;
        const observing: StaticCssEvalSourceProvider = {
          async resolve(...args) {
            try {
              const value = await provider.resolve(...args);
              observations.push({
                kind: "resolve",
                args,
                digest: digest(value)
              });

              return value;
            } catch (error) {
              cacheable = false;

              throw error;
            }
          },

          async load(...args) {
            try {
              const value = await provider.load(...args);
              observations.push({ kind: "load", args, digest: digest(value) });

              return value;
            } catch (error) {
              cacheable = false;

              throw error;
            }
          }
        };

        const transformed = await this.prepare(
          options,
          result,
          observing,
          () => {
            cacheable = false;
          }
        );

        const output =
          transformed === result
            ? null
            : {
                code: transformed.code,
                map: transformed.map,
                dependencies: transformed.staticCssEval?.dependencyFiles ?? []
              };

        const dependencies = new Set([
          options.filename,
          ...(output?.dependencies ?? [])
        ]);

        for (const observation of observations)
          if (observation.kind === "load")
            dependencies.add(observation.args[0]);

        const value = { output, observations };

        return {
          owner: options.filename,
          value,
          dependencies: [...dependencies],
          bytes: cacheable
            ? Buffer.byteLength(JSON.stringify(value))
            : Infinity,

          valid: async () => true
        };
      },
      async ({ observations }) => {
        // Loading sidecars here runs this generation's normal CSS evaluation.
        // An analysis hit never substitutes old registry state or CSS results.
        for (const observation of observations) {
          const current =
            observation.kind === "load"
              ? await provider.load(...observation.args)
              : await provider.resolve(...observation.args);
          if (digest(current) !== observation.digest) return false;
        }

        return true;
      }
    );

    return cached.output
      ? this.withOutput(result, structuredClone(cached.output))
      : result;
  }

  private async prepare(
    options: BabelTransformSourceOptions,
    result: BabelTransformResult,
    provider: StaticCssEvalSourceProvider,
    failed: () => void
  ): Promise<BabelTransformResult> {
    const optimize = options.babel?.optimize;
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
    ).catch(() => {
      failed();

      return null;
    });
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
      ast: analysis.ast,
      filename: options.filename,
      source: result.code,
      replacements,
      elements,
      sourceMaps: options.sourceMaps,
      inputSourceMap: result.map ?? undefined
    });
    if (!transformed?.code) return result;

    for (const file of analysis.dependencies) dependencies.add(file);

    return this.withOutput(result, {
      code: transformed.code,
      ...(options.sourceMaps ? { map: transformed.map } : {}),
      dependencies: [...dependencies]
    });
  }

  private withOutput(
    result: BabelTransformResult,
    output: {
      code: string;
      map?: BabelTransformResult["map"];
      dependencies: readonly string[];
    }
  ): BabelTransformResult {
    const previous = result.staticCssEval;

    return {
      ...result,
      code: output.code,
      ...(output.map !== undefined ? { map: output.map } : {}),
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
          ...new Set([
            ...(previous?.dependencyFiles ?? []),
            ...output.dependencies
          ])
        ]
      }
    };
  }
}
