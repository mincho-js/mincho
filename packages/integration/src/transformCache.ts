import { join, resolve } from "node:path";
import { restoreTransform, snapshotTransform } from "./transformSnapshot.js";
import type {
  BabelTransformResult,
  BabelTransformSourceOptions,
  StaticCssEvalLoadedSource,
  StaticCssEvalSourceProvider
} from "./babel.js";
import { cacheDigest, type CompilationCache } from "./compilationCache.js";
import { recordCompilationDiagnostic } from "./diagnostics.js";
import {
  semanticWitnesses,
  unchangedSemanticSource,
  sourcePolicy
} from "./semanticDependencies.js";

type Observation =
  | {
      kind: "resolve";
      args: Parameters<StaticCssEvalSourceProvider["resolve"]>;
      digest: string;
      policy: string;
      files: string[];
    }
  | {
      kind: "load";
      args: Parameters<StaticCssEvalSourceProvider["load"]>;
      digest: string;
      policy: string;
      files: string[];
    };

function digest(value: unknown): string {
  return cacheDigest(JSON.stringify(value) ?? "undefined");
}

export function cachedTransform(
  cache: CompilationCache,
  options: BabelTransformSourceOptions,
  transform: (
    input: BabelTransformSourceOptions,
    reuseSourceAst?: boolean
  ) => Promise<BabelTransformResult>
): Promise<BabelTransformResult> {
  return cache.withInputs(() => transformWithInputs(cache, options, transform));
}

/** Never cache arbitrary Babel plugins or an opaque synchronous value provider. */
async function transformWithInputs(
  cache: CompilationCache,
  options: BabelTransformSourceOptions,
  transform: (
    input: BabelTransformSourceOptions,
    reuseSourceAst?: boolean
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

    configurations = await cache.fingerprint([
      options.filename,
      ...cache.configurationFiles([
        options.filename,
        join(babelRoot, "babel.config.js")
      ])
    ]);
  } catch {
    return transform(options);
  }

  if (await cache.hasExternalBabelConfiguration(configurations)) {
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
      const loads = new Map<string, StaticCssEvalLoadedSource | null>();
      const aliases = new Map<string, string[]>();
      let cacheable = true;
      const observingProvider: StaticCssEvalSourceProvider | undefined =
        provider && {
          async resolve(...args) {
            try {
              const value = await provider.resolve(...args);
              const files = [
                ...new Set(
                  [
                    value?.id,
                    value?.resolvedFile,
                    value?.canonicalModuleId,
                    value?.normalizedPathKey,
                    value?.realpath
                  ].filter((id): id is string => !!id)
                )
              ];

              for (const id of files) aliases.set(id, files);

              observations.push({
                kind: "resolve",
                args,
                digest: digest(value),
                policy: sourcePolicy(value),
                files
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
              const files = aliases.get(args[0]) ?? [args[0]];

              for (const file of files) loads.set(file, value);

              observations.push({
                kind: "load",
                args,
                digest: digest(value),
                policy: sourcePolicy(value),
                files
              });

              return value;
            } catch (error) {
              cacheable = false;

              throw error;
            }
          }
        };

      const result = await transform(
        {
          ...options,
          babel: {
            ...options.babel,
            staticCssEvalSourceProvider: observingProvider
          }
        },
        true
      );

      const files = [
        options.filename,
        ...(result.staticCssEval?.dependencyFiles ?? []),
        ...configurations.keys()
      ];

      const { result: snapshot, modules } = snapshotTransform(result);
      const witnesses = semanticWitnesses(
        result,
        loads,
        options.filename,
        cache
      );

      const semanticFiles = witnesses.map(({ file }) => file);
      const hardInputs = new Map(
        [...configurations].filter(([file]) => !semanticFiles.includes(file))
      );

      return {
        value: { result: snapshot, modules, observations, witnesses },
        owner: options.filename,
        dependencies: files,
        bytes: cacheable
          ? Buffer.byteLength(
              JSON.stringify([
                result.code,
                result.result,
                result.map,
                modules,
                observations,
                witnesses
              ])
            )
          : Infinity,

        valid: () => cache.unchanged(hardInputs),

        ...(cacheable
          ? { manifest: { fingerprints: [...hardInputs], semanticFiles } }
          : {})
      };
    },
    async (snapshot) => {
      const { observations, witnesses } = snapshot;
      const fresh = new Map<string, StaticCssEvalLoadedSource>();
      const changed = new Set<string>();
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

        if (digest(value) !== observation.digest) {
          const witness = witnesses.find(({ file }) =>
            observation.files.includes(file)
          );
          if (!witness || sourcePolicy(value) !== observation.policy)
            return false;

          if (observation.kind === "load") {
            if (
              !unchangedSemanticSource(
                witness,
                value as StaticCssEvalLoadedSource | null,
                cache
              )
            )
              return false;

            changed.add(witness.file);
          }
        }

        if (observation.kind === "load" && value)
          for (const file of observation.files)
            fresh.set(file, value as StaticCssEvalLoadedSource);
      }

      if (changed.size) {
        await cache.fingerprint(changed);

        for (const [id, module] of snapshot.modules) {
          const value = fresh.get(id);
          const source = value?.sourceText ?? value?.source;

          if (source !== undefined && value)
            Object.assign(module, {
              source,
              sourceHash:
                value.sourceIdentity?.sourceHash ??
                value.sourceHash ??
                cacheDigest(source),
              version: value.sourceIdentity?.version ?? value.version
            });
        }

        const metadata = snapshot.result.staticCssEval;

        if (metadata)
          for (const item of [
            ...metadata.dependencies,
            ...metadata.resolvedDependencies,
            ...metadata.cacheKeys
          ]) {
            const file = "file" in item ? item.file : item.resolvedFile;
            const value = file ? fresh.get(file) : undefined;
            const source = value?.sourceText ?? value?.source;

            if (source !== undefined && value)
              Object.assign(item, {
                sourceHash:
                  value.sourceIdentity?.sourceHash ??
                  value.sourceHash ??
                  cacheDigest(source),
                sourceVersion: value.sourceIdentity?.version ?? value.version
              });
          }

        recordCompilationDiagnostic("semantic-dependency-hit", {
          files: [...changed]
        });
      }

      return true;
    }
  );

  // Results include maps and mutable metadata. Each transform owns its copy.
  const result = restoreTransform(cached, cache);

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
