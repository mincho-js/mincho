import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { collectStaticCssEvalCjsExportMapOperations } from "./cjsExports.js";
import type { StaticCssEvalCjsExportMapOperation } from "./cjsExports.js";
import { createStaticCssEvalDiagnostic } from "./diagnostics.js";
import { parseStaticCssModuleProgram } from "./moduleParser.js";
import type {
  StaticCssEvalDiagnostic,
  StaticCssEvalExportName,
  StaticCssEvalParserOptionsKey,
  StaticCssEvalSourceLocation,
  StaticCssEvalUnsupportedReason
} from "./types.js";

export const STATIC_CSS_MODULE_CACHE_PARSER_VERSION = "babel-core-parser:v2";
export const STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION =
  "static-css-module-export-graph:v2";
export interface StaticCssModuleSource {
  resolvedFile: string;
  source: string;
  sourceHash: string;
  sourceVersion?: string | number;
}

export interface ExportMapCacheKey {
  resolvedFile: string;
  sourceHash: string;
  parserVersion: string;
  supportVersion: string;
  parserOptions: StaticCssEvalParserOptionsKey;
  sourceVersion?: string | number;
}

export type StaticCssModuleExportDeclaration =
  | t.ExportAllDeclaration
  | t.ExportDefaultDeclaration
  | t.ExportNamedDeclaration;

export interface ParsedStaticCssModule {
  file: string;
  resolvedFile: string;
  source: string;
  sourceHash: string;
  sourceVersionHash: string;
  cacheKey: ExportMapCacheKey;
  ast: t.File;
  program: t.Program;
  programPath: NodePath<t.Program>;
  importDeclarations: readonly t.ImportDeclaration[];
  exportDeclarations: readonly StaticCssModuleExportDeclaration[];
  exportMap: ReadonlyMap<StaticCssEvalExportName, ExportMapEntry>;
  exportGraph: readonly ExportGraphEntry[];
  exportStarReexports: readonly ExportGraphStarReexportEntry[];
  unsupportedExportStars: readonly ExportGraphStarReexportEntry[];
  sourceVersion?: string | number;
}

export type ExportMapEntry =
  | ExportMapExpressionEntry
  | ExportMapLocalEntry
  | ExportMapReexportEntry
  | ExportMapUnsupportedEntry;

export interface ExportMapExpressionEntry {
  kind: "expression";
  exportName: StaticCssEvalExportName;
  expression: t.Expression;
  declaration: t.ExportDefaultDeclaration | t.Statement;
}

export interface ExportMapLocalEntry {
  kind: "local";
  exportName: StaticCssEvalExportName;
  localName: string;
  declarationKind: "class" | "const" | "function" | "let" | "specifier" | "var";
  declaration: t.Declaration | t.ExportNamedDeclaration;
}

export interface ExportMapReexportEntry {
  kind: "reexport";
  exportName: StaticCssEvalExportName;
  importedName: string;
  source: string;
  declaration: t.ExportNamedDeclaration | t.Statement;
}

export interface ExportMapUnsupportedEntry {
  kind: "unsupported";
  exportName: StaticCssEvalExportName;
  unsupportedKind:
    | "cjs-bundle-runtime"
    | "cjs-helper"
    | "cjs-export"
    | "default-declaration"
    | "export-namespace"
    | "export-star";
  declaration: StaticCssModuleExportDeclaration | t.Statement;
  diagnostic: StaticCssEvalDiagnostic;
  source?: string;
  cjsExportMutation?: string;
  cjsHelperName?: string;
  cjsBundleRuntimeName?: string;
}

export type ExportGraphEntry = ExportMapEntry | ExportGraphStarReexportEntry;

export interface ExportGraphStarReexportEntry {
  readonly kind: "star-reexport";
  readonly exportName: "*";
  readonly source: string;
  readonly declaration: t.ExportAllDeclaration | t.Statement;
}

export interface StaticCssModuleExportStarSource {
  readonly entry: ExportGraphStarReexportEntry;
  readonly exportNames: readonly StaticCssEvalExportName[];
}

export type StaticCssModuleExportNameTableEntry =
  | StaticCssModuleExportNameExplicitEntry
  | StaticCssModuleExportNameStarEntry
  | StaticCssModuleExportNameAmbiguousStarEntry;

export interface StaticCssModuleExportNameExplicitEntry {
  readonly kind: "explicit";
  readonly exportName: StaticCssEvalExportName;
  readonly entry: ExportMapEntry;
}

export interface StaticCssModuleExportNameStarEntry {
  readonly kind: "star";
  readonly exportName: StaticCssEvalExportName;
  readonly source: string;
  readonly entry: ExportGraphStarReexportEntry;
}

export interface StaticCssModuleExportNameAmbiguousStarEntry {
  readonly kind: "ambiguous-star";
  readonly exportName: StaticCssEvalExportName;
  readonly sources: readonly string[];
  readonly starEntries: readonly ExportGraphStarReexportEntry[];
}

interface StaticCssModuleExportGraphBuildState {
  file: string;
  exportMap: Map<StaticCssEvalExportName, ExportMapEntry>;
  exportGraph: ExportGraphEntry[];
  exportStarReexports: ExportGraphStarReexportEntry[];
  unsupportedExportStars: ExportGraphStarReexportEntry[];
  cjsExportNames: Set<StaticCssEvalExportName>;
}

export interface StaticCssModuleCache {
  getParsedModule(source: StaticCssModuleSource): ParsedStaticCssModule;
  getExportMap(
    source: StaticCssModuleSource
  ): ReadonlyMap<StaticCssEvalExportName, ExportMapEntry>;
  getExportMapEntry(
    source: StaticCssModuleSource,
    exportName: StaticCssEvalExportName
  ): ExportMapEntry | null;
}

interface StaticCssModuleCacheInstrumentation {
  hits: number;
  misses: number;
  parseCountByFile: Map<string, number>;
}

interface StaticCssModuleCacheInstrumentationSnapshot {
  hits: number;
  misses: number;
  parseCountByFile: ReadonlyMap<string, number>;
}

const cacheInstrumentation = new WeakMap<
  StaticCssModuleCache,
  StaticCssModuleCacheInstrumentation
>();

export function createStaticCssModuleCache(): StaticCssModuleCache {
  const parsedModules = new Map<string, ParsedStaticCssModule>();
  const instrumentation: StaticCssModuleCacheInstrumentation = {
    hits: 0,
    misses: 0,
    parseCountByFile: new Map<string, number>()
  };

  const cache: StaticCssModuleCache = {
    getParsedModule(source) {
      const cacheKey = createExportMapCacheKey(source);
      const formattedCacheKey = formatExportMapCacheKey(cacheKey);
      const parsedModule = parsedModules.get(formattedCacheKey);

      if (parsedModule) {
        instrumentation.hits += 1;
        return parsedModule;
      }

      instrumentation.misses += 1;
      instrumentation.parseCountByFile.set(
        source.resolvedFile,
        (instrumentation.parseCountByFile.get(source.resolvedFile) ?? 0) + 1
      );

      const nextParsedModule = parseStaticCssModule(source, cacheKey);
      parsedModules.set(formattedCacheKey, nextParsedModule);
      return nextParsedModule;
    },
    getExportMap(source) {
      return this.getParsedModule(source).exportMap;
    },
    getExportMapEntry(source, exportName) {
      return this.getParsedModule(source).exportMap.get(exportName) ?? null;
    }
  };

  cacheInstrumentation.set(cache, instrumentation);
  return cache;
}

export function createExportMapCacheKey(
  source: StaticCssModuleSource
): ExportMapCacheKey {
  return {
    resolvedFile: source.resolvedFile,
    sourceHash: source.sourceHash,
    parserVersion: STATIC_CSS_MODULE_CACHE_PARSER_VERSION,
    supportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION,
    parserOptions: getStaticCssModuleParserOptions(source.resolvedFile),
    ...(source.sourceVersion !== undefined
      ? { sourceVersion: source.sourceVersion }
      : {})
  };
}

export function formatExportMapCacheKey(cacheKey: ExportMapCacheKey): string {
  return JSON.stringify({
    resolvedFile: cacheKey.resolvedFile,
    sourceHash: cacheKey.sourceHash,
    sourceVersion: cacheKey.sourceVersion ?? null,
    parserVersion: cacheKey.parserVersion,
    supportVersion: cacheKey.supportVersion,
    parserOptions: cacheKey.parserOptions
  });
}

function parseStaticCssModule(
  source: StaticCssModuleSource,
  cacheKey: ExportMapCacheKey
): ParsedStaticCssModule {
  const { ast, programPath } = parseStaticCssModuleProgram({
    resolvedFile: source.resolvedFile,
    source: source.source,
    parserOptions: cacheKey.parserOptions
  });

  const importDeclarations: t.ImportDeclaration[] = [];
  const exportDeclarations: StaticCssModuleExportDeclaration[] = [];

  for (const statement of programPath.node.body) {
    if (t.isImportDeclaration(statement)) {
      importDeclarations.push(statement);
      continue;
    }

    if (isStaticCssModuleExportDeclaration(statement)) {
      exportDeclarations.push(statement);
    }
  }

  const {
    exportMap,
    exportGraph,
    exportStarReexports,
    unsupportedExportStars
  } = buildStaticCssModuleExportMap(
    source.resolvedFile,
    exportDeclarations,
    programPath
  );

  return {
    file: source.resolvedFile,
    resolvedFile: source.resolvedFile,
    source: source.source,
    sourceHash: source.sourceHash,
    sourceVersionHash: createSourceVersionHash(source),
    cacheKey,
    ast,
    program: programPath.node,
    programPath,
    importDeclarations,
    exportDeclarations,
    exportMap,
    exportGraph,
    exportStarReexports,
    unsupportedExportStars,
    ...(source.sourceVersion !== undefined
      ? { sourceVersion: source.sourceVersion }
      : {})
  };
}

function getStaticCssModuleParserOptions(
  filePath: string
): StaticCssEvalParserOptionsKey {
  const typescript =
    /\.[cm]?tsx?$/.test(filePath) ||
    /^(?:\0?virtual:|pkg:|data:)/.test(filePath);
  const jsx = /\.[jt]sx$/.test(filePath);

  return {
    plugins: [
      ...(jsx ? (["jsx"] as const) : []),
      ...(typescript ? (["typescript"] as const) : [])
    ],
    sourceType: "unambiguous",
    jsx,
    typescript
  };
}

function buildStaticCssModuleExportMap(
  file: string,
  exportDeclarations: readonly StaticCssModuleExportDeclaration[],
  programPath: NodePath<t.Program>
): {
  exportMap: ReadonlyMap<StaticCssEvalExportName, ExportMapEntry>;
  exportGraph: readonly ExportGraphEntry[];
  exportStarReexports: readonly ExportGraphStarReexportEntry[];
  unsupportedExportStars: readonly ExportGraphStarReexportEntry[];
} {
  const state: StaticCssModuleExportGraphBuildState = {
    file,
    exportMap: new Map<StaticCssEvalExportName, ExportMapEntry>(),
    exportGraph: [],
    exportStarReexports: [],
    unsupportedExportStars: [],
    cjsExportNames: new Set<StaticCssEvalExportName>()
  };

  for (const declaration of exportDeclarations) {
    collectStaticCssModuleExportEntries(declaration, state);
  }

  if (programPath.node.sourceType === "script") {
    for (const operation of collectStaticCssEvalCjsExportMapOperations({
      file,
      programPath
    })) {
      applyStaticCssEvalCjsExportMapOperation(operation, state);
    }
  }

  return {
    exportMap: state.exportMap,
    exportGraph: state.exportGraph,
    exportStarReexports: state.exportStarReexports,
    unsupportedExportStars: state.unsupportedExportStars
  };
}

function collectStaticCssModuleExportEntries(
  declaration: StaticCssModuleExportDeclaration,
  state: StaticCssModuleExportGraphBuildState
): void {
  if (t.isExportAllDeclaration(declaration)) {
    collectExportAllDeclaration(declaration, state);
    return;
  }

  if (t.isExportDefaultDeclaration(declaration)) {
    collectDefaultExportEntry(declaration, state);
    return;
  }

  if (declaration.exportKind === "type") {
    return;
  }

  if (declaration.source) {
    collectDirectNamedReexportEntries(declaration, state);
    return;
  }

  if (declaration.declaration) {
    collectDeclaredExportEntries(declaration.declaration, state);
    return;
  }

  collectLocalSpecifierExportEntries(declaration, state);
}

function collectExportAllDeclaration(
  declaration: t.ExportAllDeclaration,
  state: StaticCssModuleExportGraphBuildState
): void {
  if (declaration.exportKind === "type") {
    return;
  }

  addExportStarReexportEntry(state, {
    kind: "star-reexport",
    exportName: "*",
    source: declaration.source.value,
    declaration
  });
}

function collectDefaultExportEntry(
  declaration: t.ExportDefaultDeclaration,
  state: StaticCssModuleExportGraphBuildState
): void {
  if (t.isExpression(declaration.declaration)) {
    addExportMapEntry(state, {
      kind: "expression",
      exportName: "default",
      expression: declaration.declaration,
      declaration
    });
    return;
  }

  addExportMapEntry(state, {
    kind: "unsupported",
    exportName: "default",
    unsupportedKind: "default-declaration",
    declaration,
    diagnostic: createUnsupportedDiagnostic({
      id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED",
      owner: { file: state.file },
      detail: "default export declaration is not a static expression",
      reason: "runtime-dynamic-value",
      exportName: "default"
    })
  });
}

function collectDeclaredExportEntries(
  declaration: t.Declaration,
  state: StaticCssModuleExportGraphBuildState
): void {
  if (t.isVariableDeclaration(declaration)) {
    const declarationKind = declaration.kind;

    if (!isStaticCssModuleVariableDeclarationKind(declarationKind)) {
      return;
    }

    for (const declarator of declaration.declarations) {
      if (!t.isIdentifier(declarator.id)) {
        continue;
      }

      addExportMapEntry(state, {
        kind: "local",
        exportName: declarator.id.name,
        localName: declarator.id.name,
        declarationKind,
        declaration
      });
    }
    return;
  }

  if (
    (t.isFunctionDeclaration(declaration) ||
      t.isClassDeclaration(declaration)) &&
    declaration.id
  ) {
    addExportMapEntry(state, {
      kind: "local",
      exportName: declaration.id.name,
      localName: declaration.id.name,
      declarationKind: t.isFunctionDeclaration(declaration)
        ? "function"
        : "class",
      declaration
    });
  }
}

function collectLocalSpecifierExportEntries(
  declaration: t.ExportNamedDeclaration,
  state: StaticCssModuleExportGraphBuildState
): void {
  for (const specifier of declaration.specifiers) {
    if (!t.isExportSpecifier(specifier) || specifier.exportKind === "type") {
      continue;
    }

    const localName = getStaticCssModuleName(specifier.local);
    const exportName = getStaticCssModuleName(specifier.exported);

    if (!localName || !exportName) {
      continue;
    }

    addExportMapEntry(state, {
      kind: "local",
      exportName,
      localName,
      declarationKind: "specifier",
      declaration
    });
  }
}

function collectDirectNamedReexportEntries(
  declaration: t.ExportNamedDeclaration,
  state: StaticCssModuleExportGraphBuildState
): void {
  for (const specifier of declaration.specifiers) {
    if (t.isExportSpecifier(specifier) && specifier.exportKind !== "type") {
      const importedName = getStaticCssModuleName(specifier.local);
      const exportName = getStaticCssModuleName(specifier.exported);

      if (importedName && exportName) {
        addExportMapEntry(state, {
          kind: "reexport",
          exportName,
          importedName,
          source: declaration.source?.value ?? "",
          declaration
        });
      }
      continue;
    }

    if (t.isExportNamespaceSpecifier(specifier)) {
      const exportName = getStaticCssModuleName(specifier.exported);

      if (exportName) {
        addExportMapEntry(state, {
          kind: "unsupported",
          exportName,
          unsupportedKind: "export-namespace",
          declaration,
          source: declaration.source?.value,
          diagnostic: createUnsupportedDiagnostic({
            id: "STATIC_CSS_EVAL_NAMESPACE_UNSUPPORTED",
            owner: { file: state.file },
            detail: `namespace re-export "${exportName}" is unsupported`,
            reason: "unsupported-namespace-reexport",
            exportName,
            importPath: declaration.source?.value
          })
        });
      }
    }
  }
}

function addExportMapEntry(
  state: StaticCssModuleExportGraphBuildState,
  entry: ExportMapEntry
): void {
  state.exportMap.set(entry.exportName, entry);
  state.exportGraph.push(entry);
}

function applyStaticCssEvalCjsExportMapOperation(
  operation: StaticCssEvalCjsExportMapOperation,
  state: StaticCssModuleExportGraphBuildState
): void {
  switch (operation.kind) {
    case "clear-cjs-exports":
      for (const exportName of state.cjsExportNames) {
        state.exportMap.delete(exportName);
      }
      state.exportStarReexports = state.exportStarReexports.filter(
        (entry) => !state.cjsExportNames.has(entry.exportName)
      );
      state.unsupportedExportStars = state.unsupportedExportStars.filter(
        (entry) => !state.cjsExportNames.has(entry.exportName)
      );
      state.exportGraph = state.exportGraph.filter(
        (entry) =>
          entry.kind !== "star-reexport" ||
          !state.cjsExportNames.has(entry.exportName)
      );
      state.cjsExportNames.clear();
      return;
    case "preserve-cjs-exports":
      return;
    case "set":
      state.cjsExportNames.add(operation.entry.exportName);
      addExportMapEntry(state, operation.entry);
      return;
    case "star-reexport":
      state.cjsExportNames.add(operation.entry.exportName);
      addExportStarReexportEntry(state, operation.entry);
      return;
    default:
      return assertNever(operation);
  }
}

function addExportStarReexportEntry(
  state: StaticCssModuleExportGraphBuildState,
  entry: ExportGraphStarReexportEntry
): void {
  state.exportStarReexports.push(entry);
  state.unsupportedExportStars.push(entry);
  state.exportGraph.push(entry);
}

export function createStaticCssModuleExportNameTable(
  explicitExportMap: ReadonlyMap<StaticCssEvalExportName, ExportMapEntry>,
  starSources: readonly StaticCssModuleExportStarSource[]
): ReadonlyMap<StaticCssEvalExportName, StaticCssModuleExportNameTableEntry> {
  const exportNameTable = new Map<
    StaticCssEvalExportName,
    StaticCssModuleExportNameTableEntry
  >();

  for (const [exportName, entry] of explicitExportMap) {
    exportNameTable.set(exportName, {
      kind: "explicit",
      exportName,
      entry
    });
  }

  for (const starSource of starSources) {
    for (const exportName of starSource.exportNames) {
      if (exportName === "default" || explicitExportMap.has(exportName)) {
        continue;
      }

      addStarExportNameTableEntry(
        exportNameTable,
        exportName,
        starSource.entry
      );
    }
  }

  return exportNameTable;
}

function addStarExportNameTableEntry(
  exportNameTable: Map<
    StaticCssEvalExportName,
    StaticCssModuleExportNameTableEntry
  >,
  exportName: StaticCssEvalExportName,
  starEntry: ExportGraphStarReexportEntry
): void {
  const existing = exportNameTable.get(exportName);

  if (!existing) {
    exportNameTable.set(exportName, {
      kind: "star",
      exportName,
      source: starEntry.source,
      entry: starEntry
    });
    return;
  }

  switch (existing.kind) {
    case "explicit":
      return;
    case "star":
      if (existing.source === starEntry.source) {
        return;
      }

      exportNameTable.set(exportName, {
        kind: "ambiguous-star",
        exportName,
        sources: [existing.source, starEntry.source],
        starEntries: [existing.entry, starEntry]
      });
      return;
    case "ambiguous-star":
      if (existing.sources.includes(starEntry.source)) {
        return;
      }

      exportNameTable.set(exportName, {
        kind: "ambiguous-star",
        exportName,
        sources: [...existing.sources, starEntry.source],
        starEntries: [...existing.starEntries, starEntry]
      });
      return;
    default:
      return assertNever(existing);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected static css export graph entry: ${value}`);
}

function createUnsupportedDiagnostic(options: {
  id: NonNullable<StaticCssEvalDiagnostic["id"]>;
  owner: StaticCssEvalSourceLocation;
  detail: string;
  reason: StaticCssEvalUnsupportedReason;
  dependency?: StaticCssEvalSourceLocation;
  exportName?: StaticCssEvalExportName;
  importPath?: string;
}): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: options.id,
    code: "unsupported-source",
    reason: options.reason,
    detail: options.detail,
    owner: options.owner,
    dependency: options.dependency,
    exportName: options.exportName,
    importPath: options.importPath
  });
}

function isStaticCssModuleExportDeclaration(
  statement: t.Statement
): statement is StaticCssModuleExportDeclaration {
  return (
    t.isExportAllDeclaration(statement) ||
    t.isExportDefaultDeclaration(statement) ||
    t.isExportNamedDeclaration(statement)
  );
}

function getStaticCssModuleName(
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

function isStaticCssModuleVariableDeclarationKind(
  declarationKind: t.VariableDeclaration["kind"]
): declarationKind is "const" | "let" | "var" {
  return (
    declarationKind === "const" ||
    declarationKind === "let" ||
    declarationKind === "var"
  );
}

function createSourceVersionHash(source: StaticCssModuleSource): string {
  return source.sourceVersion === undefined
    ? source.sourceHash
    : `${source.sourceVersion}:${source.sourceHash}`;
}

function getStaticCssModuleCacheInstrumentation(
  cache: StaticCssModuleCache
): StaticCssModuleCacheInstrumentationSnapshot {
  const instrumentation = cacheInstrumentation.get(cache);

  if (!instrumentation) {
    return {
      hits: 0,
      misses: 0,
      parseCountByFile: new Map<string, number>()
    };
  }

  return {
    hits: instrumentation.hits,
    misses: instrumentation.misses,
    parseCountByFile: new Map(instrumentation.parseCountByFile)
  };
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;
  const stylesId = "/project/src/styles.ts";

  function createSource(
    source: string,
    sourceHash = "hash:styles-v1"
  ): StaticCssModuleSource {
    return {
      resolvedFile: stylesId,
      source,
      sourceHash,
      sourceVersion: "1"
    };
  }

  function expectExpressionEntry(
    entry: ExportMapEntry | null
  ): Extract<ExportMapEntry, { kind: "expression" }> {
    expect(entry?.kind).toBe("expression");

    if (!entry || entry.kind !== "expression") {
      throw new TypeError("expected expression export map entry");
    }

    return entry;
  }

  function expectUnsupportedEntry(
    entry: ExportMapEntry | null
  ): Extract<ExportMapEntry, { kind: "unsupported" }> {
    expect(entry?.kind).toBe("unsupported");

    if (!entry || entry.kind !== "unsupported") {
      throw new TypeError("expected unsupported export map entry");
    }

    return entry;
  }

  function getObjectExpressionStringProperty(
    expression: t.Expression,
    propertyName: string
  ): string | null {
    if (!t.isObjectExpression(expression)) {
      return null;
    }

    for (const property of expression.properties) {
      if (!t.isObjectProperty(property) || property.computed) {
        continue;
      }

      const keyName = t.isIdentifier(property.key)
        ? property.key.name
        : t.isStringLiteral(property.key)
          ? property.key.value
          : null;

      if (keyName !== propertyName || !t.isStringLiteral(property.value)) {
        continue;
      }

      return property.value.value;
    }

    return null;
  }

  function createTscCreateBindingHelperSource(): string {
    return `
      var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
          desc = { enumerable: true, get: function() { return m[k]; } };
        }
        Object.defineProperty(o, k2, desc);
      }) : (function(o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      }));
    `;
  }

  function createTscExportStarHelperSource(): string {
    return `
      var __exportStar = (this && this.__exportStar) || function(m, exports) {
        for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
      };
    `;
  }

  function createEsbuildHelperSource(copyPropsSource: string): string {
    return `
      var __defProp = Object.defineProperty;
      var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
      var __getOwnPropNames = Object.getOwnPropertyNames;
      var __hasOwnProp = Object.prototype.hasOwnProperty;
      var __export = (target, all) => {
        for (var name in all)
          __defProp(target, name, { get: all[name], enumerable: true });
      };
      ${copyPropsSource}
      var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    `;
  }

  function createEsbuildCopyPropsHelperSource(): string {
    return `
      var __copyProps = (to, from, except, desc) => {
        if (from && typeof from === "object" || typeof from === "function") {
          for (let key of __getOwnPropNames(from))
            if (!__hasOwnProp.call(to, key) && key !== except)
              __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
        }
        return to;
      };
    `;
  }

  describe("static css module parse/export-map cache", () => {
    it("parses the same resolved file and source identity once per cache instance", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        export const button = { color: "red" };
        export const card = { color: "blue" };
      `);

      expect(cache.getExportMapEntry(source, "button")).toMatchObject({
        kind: "local",
        exportName: "button",
        localName: "button",
        declarationKind: "const"
      });
      expect(cache.getExportMapEntry(source, "card")).toMatchObject({
        kind: "local",
        exportName: "card",
        localName: "card",
        declarationKind: "const"
      });

      const instrumentation = getStaticCssModuleCacheInstrumentation(cache);
      expect(instrumentation.misses).toBe(1);
      expect(instrumentation.hits).toBe(1);
      expect(instrumentation.parseCountByFile.get(stylesId)).toBe(1);
    });

    it("creates a new cache entry when source identity changes", () => {
      const cache = createStaticCssModuleCache();
      const firstSource = createSource(
        `export const button = { color: "red" };`
      );
      const secondSource = createSource(
        `export const button = { color: "blue" };`,
        "hash:styles-v2"
      );

      cache.getParsedModule(firstSource);
      cache.getParsedModule(secondSource);

      const instrumentation = getStaticCssModuleCacheInstrumentation(cache);
      expect(instrumentation.misses).toBe(2);
      expect(instrumentation.hits).toBe(0);
      expect(instrumentation.parseCountByFile.get(stylesId)).toBe(2);
    });

    it("tracks parsed module identity, program, imports, and exports", () => {
      const cache = createStaticCssModuleCache();
      const parsedModule = cache.getParsedModule(
        createSource(`
          import { color } from "./tokens";
          export const button = { color };
        `)
      );

      expect(parsedModule).toMatchObject({
        file: stylesId,
        resolvedFile: stylesId,
        sourceHash: "hash:styles-v1",
        sourceVersion: "1",
        sourceVersionHash: "1:hash:styles-v1",
        cacheKey: {
          resolvedFile: stylesId,
          sourceHash: "hash:styles-v1",
          sourceVersion: "1",
          parserVersion: STATIC_CSS_MODULE_CACHE_PARSER_VERSION,
          supportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
        }
      });
      expect(parsedModule.ast.type).toBe("File");
      expect(parsedModule.program.type).toBe("Program");
      expect(parsedModule.programPath.node).toBe(parsedModule.program);
      expect(parsedModule.importDeclarations).toHaveLength(1);
      expect(parsedModule.exportDeclarations).toHaveLength(1);
    });

    it("parses CommonJS source with CJS-capable parser cache identity", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        const x = require("./x");
        module.exports = x;
      `);

      const parsedModule = cache.getParsedModule(source);

      expect(parsedModule.program.sourceType).toBe("script");
      expect(parsedModule.cacheKey).toMatchObject({
        parserVersion: "babel-core-parser:v2",
        supportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION,
        parserOptions: {
          plugins: ["typescript"],
          sourceType: "unambiguous",
          jsx: false,
          typescript: true
        }
      });
      expect(parsedModule.importDeclarations).toHaveLength(0);
      expect(parsedModule.exportDeclarations).toHaveLength(0);
      expect(parsedModule.exportMap.size).toBe(1);
      expect(
        expectExpressionEntry(cache.getExportMapEntry(source, null)).expression
      ).toMatchObject({
        type: "Identifier",
        name: "x"
      });
    });

    it("collects literal CommonJS module-value exports into the export map", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`module.exports = "theme";`);

      expect(
        expectExpressionEntry(cache.getExportMapEntry(source, null)).expression
      ).toMatchObject({
        type: "StringLiteral",
        value: "theme"
      });
    });

    it("collects literal require-call CommonJS module-value exports into the export map", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`module.exports = require("./theme");`);

      expect(
        expectExpressionEntry(cache.getExportMapEntry(source, null)).expression
      ).toMatchObject({
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: "require"
        },
        arguments: [{ type: "StringLiteral", value: "./theme" }]
      });
    });

    it("collects direct CommonJS object and property exports into the export map", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        const card = { color: "blue" };
        module.exports = {
          button: { color: "red" },
          card
        };
      `);
      const buttonEntry = expectExpressionEntry(
        cache.getExportMapEntry(source, "button")
      );
      const cardEntry = expectExpressionEntry(
        cache.getExportMapEntry(source, "card")
      );

      expect(
        getObjectExpressionStringProperty(buttonEntry.expression, "color")
      ).toBe("red");
      expect(cardEntry.expression).toMatchObject({
        type: "Identifier",
        name: "card"
      });
    });

    it("lets last static top-level CommonJS property assignment win", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        exports.button = { color: "red" };
        module.exports.card = { color: "blue" };
        exports.default = { color: "green" };
        exports.button = { color: "orange" };
      `);
      const buttonEntry = expectExpressionEntry(
        cache.getExportMapEntry(source, "button")
      );
      const cardEntry = expectExpressionEntry(
        cache.getExportMapEntry(source, "card")
      );
      const defaultEntry = expectExpressionEntry(
        cache.getExportMapEntry(source, "default")
      );

      expect(
        getObjectExpressionStringProperty(buttonEntry.expression, "color")
      ).toBe("orange");
      expect(
        getObjectExpressionStringProperty(cardEntry.expression, "color")
      ).toBe("blue");
      expect(
        getObjectExpressionStringProperty(defaultEntry.expression, "color")
      ).toBe("green");
    });

    it("collects CommonJS defineProperty value and getter exports", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        const button = { color: "red" };
        const source = { card: { color: "blue" } };
        Object.defineProperty(exports, "button", {
          value: button,
          enumerable: true
        });
        Object.defineProperty(module.exports, "card", {
          enumerable: true,
          get: function () {
            return source.card;
          }
        });
      `);
      const buttonEntry = expectExpressionEntry(
        cache.getExportMapEntry(source, "button")
      );
      const cardEntry = expectExpressionEntry(
        cache.getExportMapEntry(source, "card")
      );

      expect(buttonEntry.expression).toMatchObject({
        type: "Identifier",
        name: "button"
      });
      expect(cardEntry.expression).toMatchObject({
        type: "MemberExpression"
      });
    });

    it("collects static TypeScript helper createBinding and exportStar reexports", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        ${createTscCreateBindingHelperSource()}
        ${createTscExportStarHelperSource()}
        const styles = require("./styles");
        __createBinding(exports, styles, "button");
        __createBinding(exports, styles, "card", "renamedCard");
        __exportStar(require("./theme"), exports);
        __exportStar(require("./tokens"), exports);
      `);

      const parsedModule = cache.getParsedModule(source);
      const buttonEntry = cache.getExportMapEntry(source, "button");
      const renamedCardEntry = cache.getExportMapEntry(source, "renamedCard");

      expect(buttonEntry).toMatchObject({
        kind: "reexport",
        exportName: "button",
        importedName: "button",
        source: "./styles"
      });
      expect(renamedCardEntry).toMatchObject({
        kind: "reexport",
        exportName: "renamedCard",
        importedName: "card",
        source: "./styles"
      });
      expect(parsedModule.exportStarReexports).toEqual([
        expect.objectContaining({
          kind: "star-reexport",
          exportName: "*",
          source: "./theme"
        }),
        expect.objectContaining({
          kind: "star-reexport",
          exportName: "*",
          source: "./tokens"
        })
      ]);

      const [themeStar, tokensStar] = parsedModule.exportStarReexports;

      if (!themeStar || !tokensStar) {
        throw new TypeError("expected helper export-star graph entries");
      }

      const exportNameTable = createStaticCssModuleExportNameTable(
        parsedModule.exportMap,
        [
          {
            entry: themeStar,
            exportNames: ["button", "default", "themeOnly"]
          },
          { entry: tokensStar, exportNames: ["themeOnly", "token"] }
        ]
      );

      expect(exportNameTable.get("button")).toMatchObject({
        kind: "explicit",
        exportName: "button",
        entry: expect.objectContaining({ kind: "reexport" })
      });
      expect(exportNameTable.get("default")).toBeUndefined();
      expect(exportNameTable.get("themeOnly")).toMatchObject({
        kind: "ambiguous-star",
        exportName: "themeOnly",
        sources: ["./theme", "./tokens"]
      });
      expect(exportNameTable.get("token")).toMatchObject({
        kind: "star",
        exportName: "token",
        source: "./tokens"
      });
    });

    it("clears CJS star re-export metadata on module.exports replacement", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        ${createTscCreateBindingHelperSource()}
        ${createTscExportStarHelperSource()}
        __exportStar(require("./theme"), exports);
        module.exports = { button: { color: "red" } };
      `);

      const parsedModule = cache.getParsedModule(source);
      const buttonEntry = expectExpressionEntry(
        cache.getExportMapEntry(source, "button")
      );

      expect(buttonEntry.expression).toMatchObject({
        type: "ObjectExpression"
      });
      expect(
        getObjectExpressionStringProperty(buttonEntry.expression, "color")
      ).toBe("red");
      expect(parsedModule.exportStarReexports).toHaveLength(0);
      expect(parsedModule.unsupportedExportStars).toHaveLength(0);
      expect(
        parsedModule.exportGraph.some((entry) => entry.kind === "star-reexport")
      ).toBe(false);
    });

    it("rejects TypeScript helper impostors and non-literal helper sources", () => {
      const cache = createStaticCssModuleCache();
      const alteredCreateBindingSource = createSource(`
        function __createBinding() { sideEffect(); }
        const styles = require("./styles");
        __createBinding(exports, styles, "button");
      `);
      const dynamicBindingSource = createSource(
        `
          ${createTscCreateBindingHelperSource()}
          const styles = loadStyles();
          __createBinding(exports, styles, "card");
        `,
        "hash:styles-dynamic-helper-source"
      );
      const alteredExportStarSource = createSource(
        `
          ${createTscCreateBindingHelperSource()}
          function __exportStar() { sideEffect(); }
          __exportStar(require("./styles"), exports);
        `,
        "hash:styles-altered-export-star"
      );

      const alteredCreateBindingEntry = expectUnsupportedEntry(
        cache.getExportMapEntry(alteredCreateBindingSource, "button")
      );
      const dynamicBindingEntry = expectUnsupportedEntry(
        cache.getExportMapEntry(dynamicBindingSource, "card")
      );
      const alteredExportStarModule = cache.getParsedModule(
        alteredExportStarSource
      );

      expect(alteredCreateBindingEntry).toMatchObject({
        unsupportedKind: "cjs-helper",
        diagnostic: {
          id: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED",
          exportName: "button"
        }
      });
      expect(dynamicBindingEntry).toMatchObject({
        unsupportedKind: "cjs-helper",
        diagnostic: {
          id: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED",
          exportName: "card"
        }
      });
      expect(alteredExportStarModule.exportStarReexports).toHaveLength(0);
      expect(alteredExportStarModule.exportGraph).toEqual([
        expect.objectContaining({
          kind: "unsupported",
          exportName: null,
          unsupportedKind: "cjs-helper",
          diagnostic: expect.objectContaining({
            id: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
          })
        })
      ]);
    });

    it("rejects TypeScript exportStar helpers with alternate branches", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        ${createTscCreateBindingHelperSource()}
        ${createTscExportStarHelperSource().replace(
          "__createBinding(exports, m, p);",
          "__createBinding(exports, m, p); else sideEffect();"
        )}
        __exportStar(require("./theme"), exports);
      `);
      const parsedModule = cache.getParsedModule(source);

      expect(parsedModule.exportStarReexports).toHaveLength(0);
      expect(parsedModule.exportGraph).toEqual([
        expect.objectContaining({
          kind: "unsupported",
          exportName: null,
          unsupportedKind: "cjs-helper",
          diagnostic: expect.objectContaining({
            id: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
          })
        })
      ]);
    });

    it("rejects TypeScript helper fingerprints when Object is shadowed", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        const Object = {};
        ${createTscCreateBindingHelperSource()}
        ${createTscExportStarHelperSource()}
        const styles = require("./styles");
        __createBinding(exports, styles, "button");
        __exportStar(require("./theme"), exports);
      `);
      const bindingEntry = expectUnsupportedEntry(
        cache.getExportMapEntry(source, "button")
      );
      const parsedModule = cache.getParsedModule(source);

      expect(bindingEntry).toMatchObject({
        unsupportedKind: "cjs-helper",
        diagnostic: {
          id: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED",
          exportName: "button"
        }
      });
      expect(parsedModule.exportStarReexports).toHaveLength(0);
      expect(parsedModule.exportGraph).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "unsupported",
            exportName: null,
            unsupportedKind: "cjs-helper",
            diagnostic: expect.objectContaining({
              id: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
            })
          })
        ])
      );
    });

    it("collects esbuild static CommonJS export-object helpers into the export map", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
        const button = { color: "red" };
        const root = { color: "green" };
        const styles = require("./styles");
        __export(exports, {
          button: () => button,
          default: () => root,
          themed: () => styles.button
        });
        module.exports = __toCommonJS(exports);
      `);

      const buttonEntry = expectExpressionEntry(
        cache.getExportMapEntry(source, "button")
      );
      const defaultEntry = expectExpressionEntry(
        cache.getExportMapEntry(source, "default")
      );
      const themedEntry = expectExpressionEntry(
        cache.getExportMapEntry(source, "themed")
      );

      expect(buttonEntry.expression).toMatchObject({
        type: "Identifier",
        name: "button"
      });
      expect(defaultEntry.expression).toMatchObject({
        type: "Identifier",
        name: "root"
      });
      expect(themedEntry.expression).toMatchObject({
        type: "MemberExpression"
      });
    });

    it("collects esbuild export helpers targeting direct CommonJS aliases", () => {
      const cache = createStaticCssModuleCache();
      const sources = [
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            const entry_exports = exports;
            const button = { color: "red" };
            __export(entry_exports, { button: () => button });
          `,
          "hash:esbuild-exports-alias"
        ),
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            const entry_module_exports = module.exports;
            const button = { color: "red" };
            __export(entry_module_exports, { button: () => button });
          `,
          "hash:esbuild-module-exports-alias"
        )
      ];

      for (const source of sources) {
        const buttonEntry = expectExpressionEntry(
          cache.getExportMapEntry(source, "button")
        );

        expect(buttonEntry.expression).toMatchObject({
          type: "Identifier",
          name: "button"
        });
      }
    });

    it("rejects direct CommonJS aliases after nested module.exports replacement", () => {
      const cache = createStaticCssModuleCache();
      const sources = [
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            const entry_exports = exports;
            if (enabled) {
              module.exports = {};
            }
            const button = { color: "red" };
            __export(entry_exports, { button: () => button });
          `,
          "hash:esbuild-exports-alias-nested-replacement"
        ),
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            const entry_module_exports = module.exports;
            if (enabled) {
              module.exports = {};
            }
            const button = { color: "red" };
            __export(entry_module_exports, { button: () => button });
          `,
          "hash:esbuild-module-exports-alias-nested-replacement"
        )
      ];

      for (const source of sources) {
        expect(cache.getExportMapEntry(source, "button")).toBeNull();
        const unsupportedEntry = expectUnsupportedEntry(
          cache.getExportMapEntry(source, null)
        );

        expect(unsupportedEntry).toMatchObject({
          unsupportedKind: "cjs-helper",
          diagnostic: {
            id: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED",
            exportName: null
          }
        });
      }
    });

    it("rejects esbuild export helpers with computed getter descriptor keys", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        ${createEsbuildHelperSource(
          createEsbuildCopyPropsHelperSource()
        ).replace(
          "{ get: all[name], enumerable: true }",
          '{ ["get"]: all[name], enumerable: true }'
        )}
        const button = { color: "red" };
        __export(exports, { button: () => button });
      `);
      const unsupportedEntry = expectUnsupportedEntry(
        cache.getExportMapEntry(source, null)
      );

      expect(unsupportedEntry).toMatchObject({
        unsupportedKind: "cjs-helper",
        diagnostic: {
          id: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED",
          exportName: null
        }
      });
      expect(cache.getExportMapEntry(source, "button")).toBeNull();
    });

    it("rejects esbuild export helpers with getter descriptor overrides", () => {
      const cache = createStaticCssModuleCache();
      const cases = [
        {
          descriptor:
            '{ get: all[name], ["get"]: () => all[name], enumerable: true }',
          sourceHash: "hash:esbuild-export-getter-computed-override"
        },
        {
          descriptor:
            "{ get: all[name], get: () => all[name], enumerable: true }",
          sourceHash: "hash:esbuild-export-getter-duplicate-override"
        }
      ];

      for (const { descriptor, sourceHash } of cases) {
        const source = createSource(
          `
            ${createEsbuildHelperSource(
              createEsbuildCopyPropsHelperSource()
            ).replace("{ get: all[name], enumerable: true }", descriptor)}
            const button = { color: "red" };
            __export(exports, { button: () => button });
          `,
          sourceHash
        );
        expect(cache.getExportMapEntry(source, "button")).toBeNull();
        const unsupportedEntry = expectUnsupportedEntry(
          cache.getExportMapEntry(source, null)
        );

        expect(unsupportedEntry).toMatchObject({
          unsupportedKind: "cjs-helper",
          diagnostic: {
            id: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED",
            exportName: null
          }
        });
      }
    });

    it("rejects esbuild export helpers with unsafe targets", () => {
      const cache = createStaticCssModuleCache();
      const sources = [
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            const target = {};
            const button = { color: "red" };
            __export(target, { button: () => button });
          `,
          "hash:esbuild-arbitrary-target"
        ),
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            const button = { color: "red" };
            __export(unresolved, { button: () => button });
          `,
          "hash:esbuild-unresolved-target"
        ),
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            let entry_exports = exports;
            entry_exports = {};
            const button = { color: "red" };
            __export(entry_exports, { button: () => button });
          `,
          "hash:esbuild-reassigned-alias"
        ),
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            const exports = {};
            const entry_exports = exports;
            const button = { color: "red" };
            __export(entry_exports, { button: () => button });
          `,
          "hash:esbuild-shadowed-exports-alias"
        ),
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            const module = { exports: {} };
            const entry_module_exports = module.exports;
            const button = { color: "red" };
            __export(entry_module_exports, { button: () => button });
          `,
          "hash:esbuild-shadowed-module-alias"
        ),
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            const button = { color: "red" };
            __export(entry_exports, { button: () => button });
            const entry_exports = exports;
          `,
          "hash:esbuild-use-before-alias-declaration"
        ),
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            const root_alias = exports;
            const entry_exports = root_alias;
            const button = { color: "red" };
            __export(entry_exports, { button: () => button });
          `,
          "hash:esbuild-recursive-alias"
        ),
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            const entry_module_exports = module.exports;
            module.exports = {};
            const button = { color: "red" };
            __export(entry_module_exports, { button: () => button });
          `,
          "hash:esbuild-module-exports-alias-replacement"
        ),
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            const button = { color: "red" };
            module.exports = {};
            __export(exports, { button: () => button });
          `,
          "hash:esbuild-unsafe-exports-alias"
        ),
        createSource(
          `
            ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
            const root = { color: "green" };
            const button = { color: "red" };
            module.exports = root;
            __export(module.exports, { button: () => button });
          `,
          "hash:esbuild-unsafe-module-object"
        )
      ];

      for (const source of sources) {
        const unsupportedEntry = expectUnsupportedEntry(
          cache.getExportMapEntry(source, null)
        );

        expect(unsupportedEntry).toMatchObject({
          unsupportedKind: "cjs-helper",
          diagnostic: {
            id: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED",
            exportName: null
          }
        });
        expect(cache.getExportMapEntry(source, "button")).toBeNull();
      }
    });

    it("rejects esbuild copyProps helper definitions missing required guard pieces", () => {
      const cache = createStaticCssModuleCache();
      const cases: readonly string[] = [
        `
          var __copyProps = (to, from, except, desc) => {
            if (from) {
              for (let key of __getOwnPropNames(from))
                if (!__hasOwnProp.call(to, key) && key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of Object.keys(from))
                if (!__hasOwnProp.call(to, key) && key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of __getOwnPropNames(from))
                if (key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of __getOwnPropNames(from))
                if (!__hasOwnProp.call(to, key))
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of __getOwnPropNames(from))
                if (!__hasOwnProp.call(to, key) && key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: true });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of __getOwnPropNames(from))
                if (!__hasOwnProp.call(to, key) && key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) });
            }
            return to;
          };
        `
      ];

      for (const copyPropsSource of cases) {
        const source = createSource(
          `
            ${createEsbuildHelperSource(copyPropsSource)}
            var entry_exports = {};
            const button = { color: "red" };
            __export(entry_exports, { button: () => button });
            module.exports = __toCommonJS(entry_exports);
          `,
          `hash:esbuild-copy-props-negative-${cases.indexOf(copyPropsSource)}`
        );
        const unsupportedEntry = expectUnsupportedEntry(
          cache.getExportMapEntry(source, null)
        );

        expect(unsupportedEntry).toMatchObject({
          unsupportedKind: "cjs-helper",
          diagnostic: {
            id: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED",
            exportName: null
          }
        });
        expect(cache.getExportMapEntry(source, "button")).toBeNull();
      }
    });

    it("rejects alias-unsafe CommonJS export mutations after module.exports replacement", () => {
      const cache = createStaticCssModuleCache();
      const unsafeSource = createSource(`
        const root = { color: "root" };
        module.exports = root;
        exports.button = { color: "red" };
      `);
      const safeSource = createSource(
        `
          module.exports = {};
          module.exports.button = { color: "red" };
        `,
        "hash:styles-safe-module-exports-extension"
      );
      const unsafeEntry = expectUnsupportedEntry(
        cache.getExportMapEntry(unsafeSource, "button")
      );
      const safeEntry = expectExpressionEntry(
        cache.getExportMapEntry(safeSource, "button")
      );

      expect(unsafeEntry).toMatchObject({
        unsupportedKind: "cjs-export",
        diagnostic: {
          id: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED"
        }
      });
      expect(
        getObjectExpressionStringProperty(safeEntry.expression, "color")
      ).toBe("red");
    });

    it("replaces static CommonJS property exports after nested mutations", () => {
      const cache = createStaticCssModuleCache();
      const cases = [
        {
          source: createSource(
            `
              exports.theme = { button: { color: "red" } };
              exports.theme.button = { color: "blue" };
            `,
            "hash:nested-exports-property-mutation"
          ),
          exportName: "theme",
          mutation: "nested exports.theme property assignment"
        },
        {
          source: createSource(
            `
              module.exports.a = { b: { color: "red" } };
              module.exports.a.b = { color: "blue" };
            `,
            "hash:nested-module-exports-property-mutation"
          ),
          exportName: "a",
          mutation: "nested module.exports.a property assignment"
        }
      ];

      for (const { source, exportName, mutation } of cases) {
        const unsupportedEntry = expectUnsupportedEntry(
          cache.getExportMapEntry(source, exportName)
        );

        expect(unsupportedEntry).toMatchObject({
          unsupportedKind: "cjs-export",
          cjsExportMutation: mutation,
          diagnostic: {
            id: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED",
            exportName
          }
        });
      }
    });

    it("records unsupported entries for nested computed CommonJS property bases", () => {
      const cache = createStaticCssModuleCache();
      const cases = [
        {
          source: createSource(
            `
              const name = "theme";
              exports[name].button = { color: "blue" };
            `,
            "hash:nested-computed-exports-property-base"
          ),
          mutation: "computed exports export assignment"
        },
        {
          source: createSource(
            `
              const name = "a";
              module.exports[name].button = { color: "blue" };
            `,
            "hash:nested-computed-module-exports-property-base"
          ),
          mutation: "computed module.exports export assignment"
        }
      ];

      for (const { source, mutation } of cases) {
        const unsupportedEntry = expectUnsupportedEntry(
          cache.getExportMapEntry(source, null)
        );

        expect(unsupportedEntry).toMatchObject({
          unsupportedKind: "cjs-export",
          cjsExportMutation: mutation,
          diagnostic: {
            id: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED",
            exportName: null
          }
        });
      }
    });

    it("leaves depth-three CommonJS member mutations out of export tracking", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(
        `
          exports.theme = { button: { color: "red" } };
          exports.theme.button.color = "blue";
        `,
        "hash:depth-three-exports-property-mutation"
      );

      expectExpressionEntry(cache.getExportMapEntry(source, "theme"));
    });

    it("records deterministic unsupported entries for unsafe CommonJS export descriptors", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        const name = "button";
        const button = { color: "red" };
        exports[name] = button;
        Object.defineProperty(exports, "spread", {
          ...descriptor,
          value: button
        });
        Object.defineProperty(exports, "setter", {
          set: function (value) {},
          value: button
        });
        Object.defineProperty(exports, "getter", {
          get: function () {
            track();
            return button;
          }
        });
        if (enabled) {
          exports.nested = button;
        }
      `);
      const parsedModule = cache.getParsedModule(source);

      const computedEntry = expectUnsupportedEntry(
        cache.getExportMapEntry(source, null)
      );

      expect(computedEntry).toMatchObject({
        unsupportedKind: "cjs-export",
        diagnostic: {
          id: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED"
        }
      });
      for (const exportName of ["spread", "setter", "getter", "nested"]) {
        const unsupportedEntry = expectUnsupportedEntry(
          cache.getExportMapEntry(source, exportName)
        );

        expect(unsupportedEntry).toMatchObject({
          unsupportedKind: "cjs-export",
          diagnostic: {
            id: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED",
            exportName
          }
        });
      }
      expect(parsedModule.exportGraph).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "unsupported",
            exportName: null,
            unsupportedKind: "cjs-export"
          }),
          expect.objectContaining({
            kind: "unsupported",
            exportName: "nested",
            unsupportedKind: "cjs-export"
          })
        ])
      );
    });

    it("rejects async and generator CommonJS defineProperty getters", () => {
      const cache = createStaticCssModuleCache();
      const cases = [
        {
          source: createSource(
            `
              const button = { color: "red" };
              Object.defineProperty(exports, "asyncButton", {
                get: async function () {
                  return button;
                }
              });
            `,
            "hash:async-define-property-getter"
          ),
          exportName: "asyncButton"
        },
        {
          source: createSource(
            `
              const button = { color: "red" };
              Object.defineProperty(exports, "generatorButton", {
                get: function* () {
                  return button;
                }
              });
            `,
            "hash:generator-define-property-getter"
          ),
          exportName: "generatorButton"
        }
      ];

      for (const { source, exportName } of cases) {
        const unsupportedEntry = expectUnsupportedEntry(
          cache.getExportMapEntry(source, exportName)
        );

        expect(unsupportedEntry).toMatchObject({
          unsupportedKind: "cjs-export",
          cjsExportMutation: "Object.defineProperty getter is dynamic",
          diagnostic: {
            id: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED",
            exportName
          }
        });
      }
    });

    it("clears CommonJS export entries for chained assignments", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        const a = { color: "red" };
        const b = { color: "blue" };
        const value = { color: "green" };
        exports.a = a;
        exports.b = b;
        exports.a = exports.b = value;
      `);
      const parsedModule = cache.getParsedModule(source);
      const unsupportedEntries = parsedModule.exportGraph.filter(
        (entry) => entry.kind === "unsupported" && entry.exportName === null
      );

      expect(cache.getExportMapEntry(source, "a")).toBeNull();
      expect(cache.getExportMapEntry(source, "b")).toBeNull();
      expect(unsupportedEntries).toEqual([
        expect.objectContaining({
          unsupportedKind: "cjs-export",
          diagnostic: expect.objectContaining({
            id: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED",
            exportName: null
          })
        })
      ]);
    });

    it("preserves ESM import and export cache behavior with CJS-capable parsing", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(
        `
          import { color } from "./tokens";
          export const button = { color };
        `,
        "hash:esm-v1"
      );

      const parsedModule = cache.getParsedModule(source);
      const cachedModule = cache.getParsedModule(source);

      expect(cachedModule).toBe(parsedModule);
      expect(parsedModule.program.sourceType).toBe("module");
      expect(parsedModule.cacheKey.parserOptions.sourceType).toBe(
        "unambiguous"
      );
      expect(parsedModule.importDeclarations).toHaveLength(1);
      expect(parsedModule.exportDeclarations).toHaveLength(1);
      expect(cache.getExportMapEntry(source, "button")).toMatchObject({
        kind: "local",
        exportName: "button",
        localName: "button",
        declarationKind: "const"
      });

      const instrumentation = getStaticCssModuleCacheInstrumentation(cache);
      expect(instrumentation.misses).toBe(1);
      expect(instrumentation.hits).toBe(2);
      expect(instrumentation.parseCountByFile.get(stylesId)).toBe(1);
    });

    it("keeps ESM export map entries for module sources with CJS-like mutation", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(
        `
          import { color } from "./tokens";
          export const button = { color };
          exports.button = { color: "blue" };
        `,
        "hash:esm-module-cjs-mutation"
      );

      const parsedModule = cache.getParsedModule(source);

      expect(parsedModule.program.sourceType).toBe("module");
      expect(cache.getExportMapEntry(source, "button")).toMatchObject({
        kind: "local",
        exportName: "button",
        localName: "button",
        declarationKind: "const"
      });
      expect(
        parsedModule.exportGraph.filter(
          (entry) =>
            entry.kind === "unsupported" &&
            entry.unsupportedKind === "cjs-export"
        )
      ).toHaveLength(0);
    });

    it("recognizes supported export map entry categories", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        export const button = { color: "red" };
        const card = { color: "blue" };
        const buttonAlias = button;
        export { card, buttonAlias as primaryButton };
        export default {};
        export { button as reexportedButton } from "./button";
      `);

      expect(cache.getExportMapEntry(source, "button")).toMatchObject({
        kind: "local",
        exportName: "button",
        localName: "button",
        declarationKind: "const"
      });
      expect(cache.getExportMapEntry(source, "card")).toMatchObject({
        kind: "local",
        exportName: "card",
        localName: "card",
        declarationKind: "specifier"
      });
      expect(cache.getExportMapEntry(source, "primaryButton")).toMatchObject({
        kind: "local",
        exportName: "primaryButton",
        localName: "buttonAlias",
        declarationKind: "specifier"
      });
      expect(cache.getExportMapEntry(source, "default")).toMatchObject({
        kind: "expression",
        exportName: "default"
      });
      expect(cache.getExportMapEntry(source, "reexportedButton")).toMatchObject(
        {
          kind: "reexport",
          exportName: "reexportedButton",
          importedName: "button",
          source: "./button"
        }
      );
    });

    it("records distinct export graph entries for default direct and export star declarations", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        export const button = { color: "red" };
        const local = { color: "blue" };
        export { local as name };
        export default { color: "green" };
        export { button as buttonFromLeaf } from "./button";
        export { default as root } from "./button";
        export * from "./button";
      `);
      const parsedModule = cache.getParsedModule(source);

      expect(parsedModule.exportGraph).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "local",
            exportName: "button",
            localName: "button",
            declarationKind: "const"
          }),
          expect.objectContaining({
            kind: "local",
            exportName: "name",
            localName: "local",
            declarationKind: "specifier"
          }),
          expect.objectContaining({
            kind: "expression",
            exportName: "default"
          }),
          expect.objectContaining({
            kind: "reexport",
            exportName: "buttonFromLeaf",
            importedName: "button",
            source: "./button"
          }),
          expect.objectContaining({
            kind: "reexport",
            exportName: "root",
            importedName: "default",
            source: "./button"
          }),
          expect.objectContaining({
            kind: "star-reexport",
            exportName: "*",
            source: "./button"
          })
        ])
      );
      expect(parsedModule.exportStarReexports).toEqual([
        expect.objectContaining({
          kind: "star-reexport",
          exportName: "*",
          source: "./button"
        })
      ]);
      expect(cache.getExportMapEntry(source, "*")).toBeNull();
    });

    it("records explicit default reexports as direct graph entries", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        export { button } from "./button";
        export { default } from "./button";
      `);
      const parsedModule = cache.getParsedModule(source);

      expect(cache.getExportMapEntry(source, "button")).toMatchObject({
        kind: "reexport",
        exportName: "button",
        importedName: "button",
        source: "./button"
      });
      expect(cache.getExportMapEntry(source, "default")).toMatchObject({
        kind: "reexport",
        exportName: "default",
        importedName: "default",
        source: "./button"
      });
      expect(parsedModule.exportGraph).toEqual([
        expect.objectContaining({
          kind: "reexport",
          exportName: "button",
          importedName: "button",
          source: "./button"
        }),
        expect.objectContaining({
          kind: "reexport",
          exportName: "default",
          importedName: "default",
          source: "./button"
        })
      ]);
    });

    it("builds export star name tables without default forwarding or ambiguity guesses", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        export const localButton = { color: "red" };
        export * from "./button";
        export * from "./theme";
      `);
      const parsedModule = cache.getParsedModule(source);
      const [buttonStar, themeStar] = parsedModule.exportStarReexports;

      if (!buttonStar || !themeStar) {
        throw new TypeError("expected two export star graph entries");
      }

      expect(buttonStar).toMatchObject({ source: "./button" });
      expect(themeStar).toMatchObject({ source: "./theme" });

      const exportNameTable = createStaticCssModuleExportNameTable(
        parsedModule.exportMap,
        [
          {
            entry: buttonStar,
            exportNames: ["localButton", "button", "default", "card"]
          },
          { entry: themeStar, exportNames: ["button", "color"] }
        ]
      );

      expect(exportNameTable.get("localButton")).toMatchObject({
        kind: "explicit",
        exportName: "localButton",
        entry: expect.objectContaining({ kind: "local" })
      });
      expect(exportNameTable.get("default")).toBeUndefined();
      expect(exportNameTable.get("card")).toMatchObject({
        kind: "star",
        exportName: "card",
        source: "./button"
      });
      expect(exportNameTable.get("button")).toMatchObject({
        kind: "ambiguous-star",
        exportName: "button",
        sources: ["./button", "./theme"]
      });
    });

    it("keeps namespace re-export unsupported and type-only exports out of value graph", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`
        export type { Foo } from "./types";
        export type * from "./types";
        export * as ns from "./button";
      `);
      const parsedModule = cache.getParsedModule(source);

      expect(cache.getExportMapEntry(source, "Foo")).toBeNull();
      expect(parsedModule.exportStarReexports).toHaveLength(0);
      expect(parsedModule.exportGraph).toEqual([
        expect.objectContaining({
          kind: "unsupported",
          exportName: "ns",
          unsupportedKind: "export-namespace",
          source: "./button",
          diagnostic: expect.objectContaining({
            id: "STATIC_CSS_EVAL_NAMESPACE_UNSUPPORTED",
            code: "unsupported-source",
            reason: "unsupported-namespace-reexport",
            owner: { file: stylesId },
            importPath: "./button",
            exportName: "ns"
          })
        })
      ]);
    });

    it("records export star as deterministic graph metadata without forwarding default", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`export * from "./button";`);
      const parsedModule = cache.getParsedModule(source);
      const [buttonStar] = parsedModule.exportStarReexports;

      if (!buttonStar) {
        throw new TypeError("expected one export star graph entry");
      }

      const exportNameTable = createStaticCssModuleExportNameTable(
        parsedModule.exportMap,
        [
          {
            entry: buttonStar,
            exportNames: ["button", "default"]
          }
        ]
      );

      expect(parsedModule.unsupportedExportStars).toHaveLength(1);
      expect(parsedModule.exportStarReexports).toEqual([
        expect.objectContaining({
          kind: "star-reexport",
          exportName: "*",
          source: "./button"
        })
      ]);
      expect(parsedModule.exportGraph).toEqual([
        expect.objectContaining({
          kind: "star-reexport",
          exportName: "*",
          source: "./button"
        })
      ]);
      expect(cache.getExportMapEntry(source, "*")).toBeNull();
      expect(exportNameTable.get("button")).toMatchObject({
        kind: "star",
        exportName: "button",
        source: "./button"
      });
      expect(exportNameTable.get("default")).toBeUndefined();
      expect(parsedModule.unsupportedExportStars[0]).toMatchObject({
        kind: "star-reexport",
        exportName: "*",
        source: "./button"
      });
      expect(
        getStaticCssModuleCacheInstrumentation(cache).parseCountByFile
      ).toEqual(new Map([[stylesId, 1]]));
    });
  });
}
