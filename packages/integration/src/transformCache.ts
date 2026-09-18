import { join, resolve } from "node:path";
import { internalCreateImportedStaticCssEvalModuleRecord as createRecord } from "@mincho-js/babel";
import type {
  BabelTransformResult,
  BabelTransformSourceOptions,
  StaticCssEvalSourceProvider
} from "./babel.js";
import {
  cacheDigest,
  configurationFiles,
  fingerprintFiles,
  unchangedFiles,
  hasExternalBabelConfiguration,
  type CompilationCache
} from "./compilationCache.js";
import { recordCompilationDiagnostic } from "./diagnostics.js";

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

/** Never cache arbitrary Babel plugins or an opaque synchronous value provider. */
export async function cachedTransform(
  cache: CompilationCache,
  options: BabelTransformSourceOptions,
  transform: (
    input: BabelTransformSourceOptions
  ) => Promise<BabelTransformResult>
): Promise<BabelTransformResult> {
  const {
    compilationCache: _cache,
    staticCssEvalSourceProvider: provider,
    staticCssEvalProjectEngine: engine,
    ...babel
  } = options.babel ?? {};

  if (
    babel.staticCssEvalProvider ||
    babel.plugins?.length ||
    babel.presets?.length ||
    babel.configFile ||
    babel.extends ||
    babel.env ||
    babel.overrides ||
    ((babel.extractCalls || babel.jsxCssProp) && !provider) ||
    !isSerializable(babel)
  ) {
    recordCompilationDiagnostic("cache-bypass", {
      reason: "custom-babel-configuration"
    });

    return transform(options);
  }

  let configurations: Map<string, string | null>;

  try {
    const babelRoot = resolve(
      babel.cwd ?? process.cwd(),
      "root" in babel && typeof babel.root === "string" ? babel.root : "."
    );

    configurations = await fingerprintFiles(
      configurationFiles([
        options.filename,
        join(babelRoot, "babel.config.js")
      ])
    );
  } catch {
    return transform(options);
  }

  if (await hasExternalBabelConfiguration(configurations)) {
    recordCompilationDiagnostic("cache-bypass", {
      reason: "external-babel-configuration"
    });

    return transform(options);
  }

  const key = `transform:${digest([
    options.filename,
    options.source,
    options.root,
    options.loader,
    options.sourceMaps,
    options.inputSourceMap,
    options.commonJsToEsm,
    babel,
    process.env.NODE_ENV,
    process.env.BABEL_ENV
  ])}`;

  const cached = await cache.run(
    key,
    async () => {
      const observations: Observation[] = [];
      const observingProvider: StaticCssEvalSourceProvider | undefined =
        provider && {
          async resolve(...args) {
            const value = await provider.resolve(...args);
            observations.push({ kind: "resolve", args, digest: digest(value) });

            return value;
          },

          async load(...args) {
            const value = await provider.load(...args);
            observations.push({ kind: "load", args, digest: digest(value) });

            return value;
          }
        };

      const result = await transform({
        ...options,
        babel: {
          ...options.babel,
          staticCssEvalSourceProvider: observingProvider
        }
      });

      const files = [
        options.filename,
        ...(result.staticCssEval?.dependencyFiles ?? []),
        ...configurations.keys()
      ];

      const modules = [
        ...(result.staticCssEval?.resolvedModuleCache ?? [])
      ].map(([id, record]) => {
        const {
          programPath: _path,
          parsedModule: _parsed,
          imports: _imports,
          cjsImports: _cjs,
          exports: _exports,
          ...source
        } = record;

        return [id, source] as const;
      });

      const snapshot: BabelTransformResult = {
        ...result,
        ...(result.staticCssEval
          ? {
              staticCssEval: {
                ...result.staticCssEval,
                resolvedModuleCache: new Map()
              }
            }
          : {})
      };

      return {
        value: { result: snapshot, modules, observations },
        dependencies: files,
        bytes: Buffer.byteLength(
          JSON.stringify([
            result.code,
            result.result,
            result.map,
            modules,
            observations
          ])
        ),

        valid: () => unchangedFiles(configurations)
      };
    },
    async ({ observations }) => {
      const currentProvider =
        engine && provider
          ? engine.getBabelStaticEvalProvider(options.filename, provider)
          : provider;

      for (const observation of observations) {
        if (!currentProvider) return false;

        const value =
          observation.kind === "load"
            ? await currentProvider.load(...observation.args)
            : await currentProvider.resolve(...observation.args);
        if (digest(value) !== observation.digest) return false;
      }

      return true;
    }
  );

  // Results include maps and mutable metadata. Each transform owns its copy.
  const result = structuredClone(cached.result);

  if (result.staticCssEval)
    result.staticCssEval.resolvedModuleCache = new Map(
      cached.modules.map(([id, source]) => [
        id,
        createRecord(source, cache.parser)
      ])
    );

  engine?.refreshFile({
    fileId: options.filename,
    result: result.staticCssEval,
    generatedArtifacts: result.result[1]
      ? [
          {
            kind: "sidecar-css-ts",
            ownerFile: options.filename,
            artifactFile: result.result[0],
            source: result.result[1]
          }
        ]
      : [],
    preserveProviderRecords: true
  });

  return result;
}

function isSerializable(value: unknown): boolean {
  if (
    value === null ||
    value === undefined ||
    ["string", "number", "boolean"].includes(typeof value)
  )
    return true;
  if (Array.isArray(value)) return value.every(isSerializable);

  return (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(isSerializable)
  );
}
