import { types as t } from "@babel/core";
import hash from "@emotion/hash";
import { createStaticCssEvalProviderSourceMetadata } from "../boundary.js";
import { collectStaticCssEvalCjsRequireBindings } from "../cjsBindings.js";
import type {
  StaticCssEvalProviderSourceMetadata,
  StaticCssEvalProviderSourcePolicyDescriptor
} from "../boundary.js";
import type {
  StaticCssModuleCache,
  StaticCssModuleSource
} from "../moduleCache.js";
import type {
  ImportedStaticCssEvalImportBinding,
  ImportedStaticCssEvalLoadedModule,
  ImportedStaticCssEvalModuleRecord
} from "./contracts.js";

export function createImportedStaticCssEvalModuleRecordWithCache(
  loadedModule: ImportedStaticCssEvalLoadedModule,
  moduleCache: StaticCssModuleCache
): ImportedStaticCssEvalModuleRecord {
  const parsedModule = moduleCache.getParsedModule(
    createStaticCssModuleSource(loadedModule)
  );

  const imports = new Map<string, ImportedStaticCssEvalImportBinding>();
  const cjsImports = collectStaticCssEvalCjsRequireBindings(
    parsedModule.programPath
  );

  for (const statement of parsedModule.program.body) {
    collectModuleImportBindings(statement, imports);
  }

  return {
    id: loadedModule.id,
    realpath: loadedModule.realpath ?? loadedModule.id,
    sourceHash:
      loadedModule.sourceHash ??
      createInlineStaticCssSourceHash(loadedModule.source),
    ...(loadedModule.version !== undefined
      ? { version: loadedModule.version }
      : {}),
    ...createStaticCssEvalProviderSourceMetadata(loadedModule),
    dependencies: [],
    source: loadedModule.source,
    imports,
    cjsImports,
    exports: parsedModule.exportMap,
    exportAllReexportSources: parsedModule.unsupportedExportStars.flatMap(
      (entry) => (entry.source ? [entry.source] : [])
    ),
    parsedModule,
    programPath: parsedModule.programPath
  };
}

export function collectModuleImportBindings(
  statement: t.Statement,
  imports: Map<string, ImportedStaticCssEvalImportBinding>
): void {
  if (!t.isImportDeclaration(statement) || statement.importKind === "type") {
    return;
  }

  const importPath = statement.source.value;

  for (const specifier of statement.specifiers) {
    if (t.isImportDefaultSpecifier(specifier)) {
      imports.set(specifier.local.name, {
        kind: "default",
        localName: specifier.local.name,
        importPath,
        importedName: "default"
      });
      continue;
    }

    if (t.isImportSpecifier(specifier) && specifier.importKind !== "type") {
      const importedName = getModuleStringName(specifier.imported);

      if (importedName) {
        imports.set(specifier.local.name, {
          kind: "named",
          localName: specifier.local.name,
          importPath,
          importedName
        });
      }
      continue;
    }

    if (t.isImportNamespaceSpecifier(specifier)) {
      imports.set(specifier.local.name, {
        kind: "namespace",
        localName: specifier.local.name,
        importPath
      });
    }
  }
}

export function createStaticCssModuleSource(
  loadedModule: ImportedStaticCssEvalLoadedModule
): StaticCssModuleSource {
  return {
    resolvedFile: loadedModule.id,
    source: loadedModule.source,
    sourceHash:
      loadedModule.sourceHash ??
      createInlineStaticCssSourceHash(loadedModule.source),
    ...(loadedModule.version !== undefined
      ? { sourceVersion: loadedModule.version }
      : {})
  };
}

function createInlineStaticCssSourceHash(source: string): string {
  return `inline:${hash(source)}`;
}

export function mergeImportedStaticCssEvalSourceMetadata(
  resolutionMetadata: StaticCssEvalProviderSourceMetadata,
  loadedModule: StaticCssEvalProviderSourcePolicyDescriptor | undefined
): StaticCssEvalProviderSourceMetadata {
  if (!loadedModule) {
    return resolutionMetadata;
  }

  return createStaticCssEvalProviderSourceMetadata({
    sourceKind: loadedModule.sourceKind ?? resolutionMetadata.sourceKind,
    sourceOrigin:
      loadedModule.sourceOrigin ??
      (loadedModule.sourceKind ? undefined : resolutionMetadata.sourceOrigin),
    canonicalModuleId:
      loadedModule.canonicalModuleId ?? resolutionMetadata.canonicalModuleId,
    normalizedPathKey:
      loadedModule.normalizedPathKey ?? resolutionMetadata.normalizedPathKey,
    watchFiles: loadedModule.watchFiles ?? resolutionMetadata.watchFiles,
    unsupportedReason:
      loadedModule.unsupportedReason ?? resolutionMetadata.unsupportedReason
  });
}

export function getModuleStringName(
  node: t.Identifier | t.StringLiteral
): string | null {
  if (t.isIdentifier(node)) {
    return node.name;
  }

  if (t.isStringLiteral(node)) {
    return node.value;
  }

  return null;
}
