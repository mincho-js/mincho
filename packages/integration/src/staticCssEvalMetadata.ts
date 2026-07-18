import {
  type MinchoStaticCssEvalMetadata,
  type PluginOptions
} from "@mincho-js/babel";
import type {
  StaticCssEvalPrepassResult,
  StaticCssEvalTransformResult
} from "./babel.js";

type StaticCssEvalProvider = NonNullable<
  PluginOptions["staticCssEvalProvider"]
>;
type StaticCssEvalProviderResult = ReturnType<
  StaticCssEvalProvider["getResolvedCssValue"]
>;
type StaticCssEvalMetadataDependency =
  MinchoStaticCssEvalMetadata["dependencies"][number];
type StaticCssEvalMetadataDiagnostic =
  MinchoStaticCssEvalMetadata["diagnostics"][number];
type StaticCssEvalMetadataCacheKey =
  MinchoStaticCssEvalMetadata["cacheKeys"][number];
type StaticCssEvalProviderMetadataSource = {
  dependencies?: readonly unknown[];
  diagnostics?: readonly StaticCssEvalMetadataDiagnostic[];
  diagnostic?: StaticCssEvalMetadataDiagnostic;
  cacheKey?: StaticCssEvalMetadataCacheKey;
};

export function createObservingStaticCssEvalProvider(
  provider: StaticCssEvalProvider,
  metadata: MinchoStaticCssEvalMetadata
): StaticCssEvalProvider {
  return {
    getResolvedCssValue(query): StaticCssEvalProviderResult {
      const result = provider.getResolvedCssValue(query);
      appendStaticCssEvalResultMetadata(metadata, result);
      return result;
    }
  };
}

function appendStaticCssEvalResultMetadata(
  metadata: MinchoStaticCssEvalMetadata,
  result: StaticCssEvalProviderResult
): void {
  const metadataSource = result as StaticCssEvalProviderMetadataSource;
  const dependencies = (metadataSource.dependencies ?? []).filter(
    isStaticCssEvalResolutionDependency
  );
  const diagnostics =
    metadataSource.diagnostics ??
    (metadataSource.diagnostic ? [metadataSource.diagnostic] : []);
  const cacheKeys = metadataSource.cacheKey ? [metadataSource.cacheKey] : [];

  appendUniqueMetadataItems(
    metadata.dependencies,
    dependencies,
    createStaticCssEvalDependencyKey
  );
  appendUniqueMetadataItems(
    metadata.diagnostics,
    diagnostics,
    createStaticCssEvalDiagnosticKey
  );
  appendUniqueMetadataItems(
    metadata.cacheKeys,
    cacheKeys,
    createStaticCssEvalCacheKeyKey
  );
  appendUniqueMetadataItems(
    metadata.resolvedModuleIds,
    [
      ...cacheKeys.flatMap((cacheKey) => cacheKey.resolvedId ?? []),
      ...dependencies.flatMap((dependency) =>
        dependency.kind !== "local" &&
        dependency.kind !== "unresolved" &&
        dependency.inspected
          ? [dependency.file]
          : []
      )
    ],
    (moduleId) => moduleId
  );
}

function isStaticCssEvalResolutionDependency(
  dependency: unknown
): dependency is StaticCssEvalMetadataDependency {
  return typeof dependency === "object" && dependency !== null;
}

export function getStaticCssEvalMetadata(
  metadata: unknown
): MinchoStaticCssEvalMetadata | undefined {
  const staticCssEval = (
    metadata as { minchoStaticCssEval?: MinchoStaticCssEvalMetadata } | null
  )?.minchoStaticCssEval;

  if (!staticCssEval) {
    return undefined;
  }

  return cloneStaticCssEvalMetadata(staticCssEval);
}

export function createStaticCssEvalTransformResult(
  prepassResult: StaticCssEvalPrepassResult | undefined,
  metadata: MinchoStaticCssEvalMetadata | undefined
): StaticCssEvalTransformResult | undefined {
  const staticCssEvalMetadata = metadata
    ? cloneStaticCssEvalMetadata(metadata)
    : createEmptyStaticCssEvalMetadata();
  const hasMetadata =
    staticCssEvalMetadata.dependencies.length > 0 ||
    staticCssEvalMetadata.diagnostics.length > 0 ||
    staticCssEvalMetadata.cacheKeys.length > 0 ||
    staticCssEvalMetadata.resolvedModuleIds.length > 0;

  if (!prepassResult && !hasMetadata) {
    return undefined;
  }

  return {
    dependencyFiles: prepassResult?.dependencyFiles ?? [],
    ownerToDependencies: prepassResult?.ownerToDependencies ?? new Map(),
    dependencyToOwners: prepassResult?.dependencyToOwners ?? new Map(),
    resolvedModuleCache: prepassResult?.resolvedModuleCache ?? new Map(),
    resolvedDependencies: prepassResult?.resolvedDependencies ?? [],
    ...staticCssEvalMetadata
  };
}

export function mergeStaticCssEvalMetadata(
  ...metadataItems: Array<MinchoStaticCssEvalMetadata | undefined>
): MinchoStaticCssEvalMetadata {
  const mergedMetadata = createEmptyStaticCssEvalMetadata();

  for (const metadata of metadataItems) {
    if (!metadata) {
      continue;
    }

    appendUniqueMetadataItems(
      mergedMetadata.dependencies,
      metadata.dependencies,
      createStaticCssEvalDependencyKey
    );
    appendUniqueMetadataItems(
      mergedMetadata.diagnostics,
      metadata.diagnostics,
      createStaticCssEvalDiagnosticKey
    );
    appendUniqueMetadataItems(
      mergedMetadata.cacheKeys,
      metadata.cacheKeys,
      createStaticCssEvalCacheKeyKey
    );
    appendUniqueMetadataItems(
      mergedMetadata.resolvedModuleIds,
      metadata.resolvedModuleIds,
      (moduleId) => moduleId
    );
  }

  return mergedMetadata;
}

export function createEmptyStaticCssEvalMetadata(): MinchoStaticCssEvalMetadata {
  return {
    dependencies: [],
    diagnostics: [],
    cacheKeys: [],
    resolvedModuleIds: []
  };
}

function cloneStaticCssEvalMetadata(
  metadata: MinchoStaticCssEvalMetadata
): MinchoStaticCssEvalMetadata {
  return {
    dependencies: metadata.dependencies.map((dependency) => ({
      ...dependency,
      memberPath: [...dependency.memberPath]
    })),
    diagnostics: metadata.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      owner: { ...diagnostic.owner },
      ...(diagnostic.dependency
        ? { dependency: { ...diagnostic.dependency } }
        : {}),
      ...(diagnostic.memberPath
        ? { memberPath: [...diagnostic.memberPath] }
        : {}),
      ...(diagnostic.importChain
        ? { importChain: [...diagnostic.importChain] }
        : {})
    })),
    cacheKeys: metadata.cacheKeys.map((cacheKey) => ({
      ...cacheKey,
      memberPath: [...cacheKey.memberPath],
      ...(cacheKey.parserOptions
        ? {
            parserOptions: {
              ...cacheKey.parserOptions,
              plugins: [...cacheKey.parserOptions.plugins]
            }
          }
        : {}),
      ...(cacheKey.projectLocalBoundary
        ? { projectLocalBoundary: { ...cacheKey.projectLocalBoundary } }
        : {})
    })),
    resolvedModuleIds: [...metadata.resolvedModuleIds]
  };
}

function appendUniqueMetadataItems<T>(
  target: T[],
  items: readonly T[],
  createKey: (item: T) => string
): void {
  const existingKeys = new Set(target.map(createKey));

  for (const item of items) {
    const key = createKey(item);

    if (existingKeys.has(key)) {
      continue;
    }

    existingKeys.add(key);
    target.push(item);
  }
}

function createStaticCssEvalDependencyKey(
  dependency: StaticCssEvalMetadataDependency
): string {
  return JSON.stringify([
    dependency.file,
    dependency.kind,
    dependency.importer,
    dependency.specifier,
    dependency.exportName,
    dependency.memberPath,
    dependency.inspected,
    dependency.contributed
  ]);
}

function createStaticCssEvalDiagnosticKey(
  diagnostic: StaticCssEvalMetadataDiagnostic
): string {
  return JSON.stringify([
    diagnostic.id,
    diagnostic.code,
    diagnostic.reason,
    diagnostic.message,
    diagnostic.owner.file,
    diagnostic.owner.start,
    diagnostic.owner.end,
    diagnostic.dependency?.file,
    diagnostic.importPath,
    diagnostic.exportName,
    diagnostic.memberPath,
    diagnostic.importChain
  ]);
}

function createStaticCssEvalCacheKeyKey(
  cacheKey: StaticCssEvalMetadataCacheKey
): string {
  return JSON.stringify([
    cacheKey.importerFile,
    cacheKey.resolvedFile,
    cacheKey.exportName,
    cacheKey.memberPath,
    cacheKey.sourceHash,
    cacheKey.sourceVersion,
    cacheKey.pluginOptionsVersion,
    cacheKey.resolverOptionsVersion,
    cacheKey.staticEvalSupportVersion,
    cacheKey.resolvedId
  ]);
}
