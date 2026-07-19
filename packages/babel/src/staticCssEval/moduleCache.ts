import { transformSync, types as t } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";
import { createStaticCssEvalDiagnostic } from "./diagnostics.js";
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
  declaration: t.ExportDefaultDeclaration;
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
  declaration: t.ExportNamedDeclaration;
}

export interface ExportMapUnsupportedEntry {
  kind: "unsupported";
  exportName: StaticCssEvalExportName;
  unsupportedKind: "default-declaration" | "export-namespace" | "export-star";
  declaration:
    | t.ExportAllDeclaration
    | t.ExportDefaultDeclaration
    | t.ExportNamedDeclaration;
  diagnostic: StaticCssEvalDiagnostic;
  source?: string;
}

export type ExportGraphEntry = ExportMapEntry | ExportGraphStarReexportEntry;

export interface ExportGraphStarReexportEntry {
  readonly kind: "star-reexport";
  readonly exportName: "*";
  readonly source: string;
  readonly declaration: t.ExportAllDeclaration;
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
  const parserOptions = cacheKey.parserOptions;
  const programPathRef: { current?: NodePath<t.Program> } = {};
  const captureProgramPathPlugin: PluginObj = {
    visitor: {
      Program(path: NodePath<t.Program>) {
        programPathRef.current = path;
        path.stop();
      }
    }
  };
  const result = transformSync(source.source, {
    filename: source.resolvedFile,
    ast: true,
    code: false,
    sourceType: "module",
    configFile: false,
    babelrc: false,
    parserOpts: {
      plugins: [
        ...(parserOptions.jsx ? (["jsx"] as const) : []),
        ...(parserOptions.typescript ? (["typescript"] as const) : [])
      ]
    },
    plugins: [captureProgramPathPlugin]
  });
  const programPath = programPathRef.current;

  if (!programPath || !result?.ast) {
    throw new Error(`Failed to parse static css module ${source.resolvedFile}`);
  }

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
  } = buildStaticCssModuleExportMap(source.resolvedFile, exportDeclarations);

  return {
    file: source.resolvedFile,
    resolvedFile: source.resolvedFile,
    source: source.source,
    sourceHash: source.sourceHash,
    sourceVersionHash: createSourceVersionHash(source),
    cacheKey,
    ast: result.ast,
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
    sourceType: "module",
    jsx,
    typescript
  };
}

function buildStaticCssModuleExportMap(
  file: string,
  exportDeclarations: readonly StaticCssModuleExportDeclaration[]
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
    unsupportedExportStars: []
  };

  for (const declaration of exportDeclarations) {
    collectStaticCssModuleExportEntries(declaration, state);
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
