import type { types as t } from "@babel/core";
import type { Scope } from "@babel/traverse";
import { createStaticCssEvalCandidate } from "../staticCssEval/candidates.js";
import type {
  ResolutionDependency,
  StaticCssEvalCacheKey,
  StaticCssEvalDiagnostic
} from "../staticCssEval/types.js";
import type { MinchoStaticCssEvalMetadata, PluginState } from "../types.js";
import {
  hasTopLevelCssRuleCallArrayBranchExpression,
  hasTopLevelCssRuleCallBranchExpression,
  isDirectLogicalCssRuleExpression,
  isTopLevelCssRuleCallExpression
} from "./classification.js";
import type {
  CssPropValueClassification,
  StaticCssEvalMetadataSource
} from "./types.js";

export function registerImportedStaticCssEvalProviderResultMetadata(options: {
  expression: t.Expression;
  ownerFile: string;
  state: PluginState;
}): void {
  const { staticCssEvalProvider } = options.state.opts;

  if (!staticCssEvalProvider) {
    return;
  }

  const candidate = createStaticCssEvalCandidate(
    options.expression,
    options.ownerFile
  );

  if (!candidate) {
    return;
  }

  registerStaticCssEvalResultMetadata(
    options.state,
    staticCssEvalProvider.getResolvedCssValue(candidate)
  );
}

export function registerStaticCssEvalResultMetadata(
  state: PluginState,
  result: StaticCssEvalMetadataSource
): void {
  const dependencies = (result.dependencies ?? []).filter(
    isResolutionDependency
  );
  const diagnostics =
    result.diagnostics ?? (result.diagnostic ? [result.diagnostic] : []);
  const cacheKeys = result.cacheKey ? [result.cacheKey] : [];

  if (
    dependencies.length === 0 &&
    diagnostics.length === 0 &&
    cacheKeys.length === 0
  ) {
    return;
  }

  const metadata = getMinchoStaticCssEvalMetadata(state);
  appendUniqueMetadataItems(
    metadata.dependencies,
    dependencies,
    createResolutionDependencyMetadataKey
  );
  appendUniqueMetadataItems(
    metadata.diagnostics,
    diagnostics,
    createStaticCssEvalDiagnosticMetadataKey
  );
  appendUniqueMetadataItems(
    metadata.cacheKeys,
    cacheKeys,
    createStaticCssEvalCacheKeyMetadataKey
  );
  appendUniqueResolvedModuleIds(metadata, dependencies, cacheKeys);
}

export function registerStaticCssEvalDiagnosticMetadata(
  state: PluginState,
  diagnostic: StaticCssEvalDiagnostic
): void {
  registerStaticCssEvalResultMetadata(state, { diagnostics: [diagnostic] });
}

function getMinchoStaticCssEvalMetadata(
  state: PluginState
): MinchoStaticCssEvalMetadata {
  const metadata = state.file.metadata.minchoStaticCssEval;

  if (metadata) {
    return metadata;
  }

  const nextMetadata: MinchoStaticCssEvalMetadata = {
    dependencies: [],
    diagnostics: [],
    cacheKeys: [],
    resolvedModuleIds: []
  };
  state.file.metadata.minchoStaticCssEval = nextMetadata;
  return nextMetadata;
}

function isResolutionDependency(
  dependency: ResolutionDependency | string
): dependency is ResolutionDependency {
  return typeof dependency === "object" && dependency !== null;
}

export function appendUniqueMetadataItems<T>(
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

export function appendUniqueResolvedModuleIds(
  metadata: MinchoStaticCssEvalMetadata,
  dependencies: readonly ResolutionDependency[],
  cacheKeys: readonly StaticCssEvalCacheKey[]
): void {
  const moduleIds = [
    ...cacheKeys.flatMap((cacheKey) => cacheKey.resolvedId ?? []),
    ...dependencies.flatMap((dependency) =>
      isResolvedModuleDependency(dependency) ? [dependency.file] : []
    )
  ];

  appendUniqueMetadataItems(
    metadata.resolvedModuleIds,
    moduleIds,
    (moduleId) => moduleId
  );
}

function isResolvedModuleDependency(dependency: ResolutionDependency): boolean {
  return (
    dependency.kind !== "local" &&
    dependency.kind !== "unresolved" &&
    dependency.inspected &&
    dependency.file.length > 0
  );
}

export function createResolutionDependencyMetadataKey(
  dependency: ResolutionDependency
): string {
  return JSON.stringify([
    dependency.file,
    dependency.kind,
    dependency.importer,
    dependency.specifier,
    dependency.exportName,
    dependency.memberPath,
    dependency.inspected,
    dependency.contributed,
    dependency.sourceKind,
    dependency.sourceOrigin,
    dependency.canonicalModuleId,
    dependency.normalizedPathKey,
    dependency.watchFiles,
    dependency.unsupportedReason
  ]);
}

export function createStaticCssEvalDiagnosticMetadataKey(
  diagnostic: StaticCssEvalDiagnostic
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

export function createStaticCssEvalCacheKeyMetadataKey(
  cacheKey: StaticCssEvalCacheKey
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
    cacheKey.parserVersion,
    cacheKey.staticEvalSupportVersion,
    cacheKey.resolvedId,
    cacheKey.sourceKind,
    cacheKey.sourceOrigin,
    cacheKey.canonicalModuleId,
    cacheKey.normalizedPathKey,
    cacheKey.watchFiles,
    cacheKey.unsupportedReason,
    cacheKey.parserOptions,
    cacheKey.projectLocalBoundary
  ]);
}

export function shouldCleanupCssModuleHelperImports(
  expression: t.Expression,
  classification: CssPropValueClassification,
  scope: Scope
): boolean {
  if (isDirectLogicalCssRuleExpression(expression, scope)) {
    return true;
  }

  if (classification === "css-rule") {
    return isTopLevelCssRuleCallExpression(expression, scope);
  }

  if (classification === "branch-css-rule") {
    return hasTopLevelCssRuleCallBranchExpression(expression, scope);
  }

  return (
    classification === "class-value" &&
    hasTopLevelCssRuleCallArrayBranchExpression(expression, scope)
  );
}
