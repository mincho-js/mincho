import { transformSync, types as t } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";
import type {
  StaticCssEvalDiagnostic,
  StaticCssEvalExportName,
  StaticCssEvalParserOptionsKey,
  StaticCssEvalSourceLocation
} from "./types.js";

export const STATIC_CSS_MODULE_CACHE_PARSER_VERSION = "babel-core-parser:v2";
export const STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION =
  "static-css-module-export-map:v1";

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
  unsupportedExportStars: readonly ExportMapUnsupportedEntry[];
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
      plugins: parserOptions.plugins
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

  const { exportMap, unsupportedExportStars } = buildStaticCssModuleExportMap(
    source.resolvedFile,
    exportDeclarations
  );

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
    unsupportedExportStars,
    ...(source.sourceVersion !== undefined
      ? { sourceVersion: source.sourceVersion }
      : {})
  };
}

function getStaticCssModuleParserOptions(
  filePath: string
): StaticCssEvalParserOptionsKey {
  const typescript = /\.[cm]?tsx?$/.test(filePath);
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
  unsupportedExportStars: readonly ExportMapUnsupportedEntry[];
} {
  const exportMap = new Map<StaticCssEvalExportName, ExportMapEntry>();
  const unsupportedExportStars: ExportMapUnsupportedEntry[] = [];

  for (const declaration of exportDeclarations) {
    collectStaticCssModuleExportEntries(file, declaration, exportMap);

    if (t.isExportAllDeclaration(declaration)) {
      const entry = createExportStarUnsupportedEntry(file, declaration);
      unsupportedExportStars.push(entry);
      exportMap.set(entry.exportName, entry);
    }
  }

  return { exportMap, unsupportedExportStars };
}

function collectStaticCssModuleExportEntries(
  file: string,
  declaration: StaticCssModuleExportDeclaration,
  exportMap: Map<StaticCssEvalExportName, ExportMapEntry>
): void {
  if (t.isExportAllDeclaration(declaration)) {
    return;
  }

  if (t.isExportDefaultDeclaration(declaration)) {
    collectDefaultExportEntry(file, declaration, exportMap);
    return;
  }

  if (declaration.exportKind === "type") {
    return;
  }

  if (declaration.source) {
    collectDirectNamedReexportEntries(declaration, exportMap);
    return;
  }

  if (declaration.declaration) {
    collectDeclaredExportEntries(declaration.declaration, exportMap);
    return;
  }

  collectLocalSpecifierExportEntries(declaration, exportMap);
}

function collectDefaultExportEntry(
  file: string,
  declaration: t.ExportDefaultDeclaration,
  exportMap: Map<StaticCssEvalExportName, ExportMapEntry>
): void {
  if (t.isExpression(declaration.declaration)) {
    exportMap.set("default", {
      kind: "expression",
      exportName: "default",
      expression: declaration.declaration,
      declaration
    });
    return;
  }

  exportMap.set("default", {
    kind: "unsupported",
    exportName: "default",
    unsupportedKind: "default-declaration",
    declaration,
    diagnostic: createUnsupportedDiagnostic({
      id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED",
      owner: { file },
      detail: "default export declaration is not a static expression",
      exportName: "default"
    })
  });
}

function collectDeclaredExportEntries(
  declaration: t.Declaration,
  exportMap: Map<StaticCssEvalExportName, ExportMapEntry>
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

      exportMap.set(declarator.id.name, {
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
    exportMap.set(declaration.id.name, {
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
  exportMap: Map<StaticCssEvalExportName, ExportMapEntry>
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

    exportMap.set(exportName, {
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
  exportMap: Map<StaticCssEvalExportName, ExportMapEntry>
): void {
  for (const specifier of declaration.specifiers) {
    if (t.isExportSpecifier(specifier) && specifier.exportKind !== "type") {
      const importedName = getStaticCssModuleName(specifier.local);
      const exportName = getStaticCssModuleName(specifier.exported);

      if (importedName && exportName) {
        exportMap.set(exportName, {
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
        exportMap.set(exportName, {
          kind: "unsupported",
          exportName,
          unsupportedKind: "export-namespace",
          declaration,
          source: declaration.source?.value,
          diagnostic: createUnsupportedDiagnostic({
            id: "STATIC_CSS_EVAL_NAMESPACE_UNSUPPORTED",
            owner: { file: declaration.source?.value ?? "<unknown>" },
            detail: `namespace re-export "${exportName}" is unsupported`,
            exportName,
            importPath: declaration.source?.value
          })
        });
      }
    }
  }
}

function createExportStarUnsupportedEntry(
  file: string,
  declaration: t.ExportAllDeclaration
): ExportMapUnsupportedEntry {
  return {
    kind: "unsupported",
    exportName: "*",
    unsupportedKind: "export-star",
    declaration,
    source: declaration.source.value,
    diagnostic: createUnsupportedDiagnostic({
      id: "STATIC_CSS_EVAL_EXPORT_STAR_UNSUPPORTED",
      owner: { file },
      dependency: { file: declaration.source.value },
      detail: `export * from "${declaration.source.value}" is unsupported`,
      exportName: "*",
      importPath: declaration.source.value
    })
  };
}

function createUnsupportedDiagnostic(options: {
  id: NonNullable<StaticCssEvalDiagnostic["id"]>;
  owner: StaticCssEvalSourceLocation;
  detail: string;
  dependency?: StaticCssEvalSourceLocation;
  exportName?: StaticCssEvalExportName;
  importPath?: string;
}): StaticCssEvalDiagnostic {
  return {
    id: options.id,
    code: "unsupported-source",
    message: `Cannot statically evaluate css prop value: ${options.detail}`,
    reason: "reexport-or-barrel",
    owner: options.owner,
    ...(options.dependency ? { dependency: options.dependency } : {}),
    ...(options.exportName !== undefined
      ? { exportName: options.exportName }
      : {}),
    ...(options.importPath !== undefined
      ? { importPath: options.importPath }
      : {})
  };
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

    it("records export star as deterministic unsupported metadata without recursion", () => {
      const cache = createStaticCssModuleCache();
      const source = createSource(`export * from "./button";`);
      const parsedModule = cache.getParsedModule(source);
      const exportStarEntry = cache.getExportMapEntry(source, "*");

      expect(parsedModule.unsupportedExportStars).toHaveLength(1);
      expect(exportStarEntry).toMatchObject({
        kind: "unsupported",
        exportName: "*",
        unsupportedKind: "export-star",
        source: "./button",
        diagnostic: {
          id: "STATIC_CSS_EVAL_EXPORT_STAR_UNSUPPORTED",
          code: "unsupported-source",
          reason: "reexport-or-barrel",
          owner: { file: stylesId },
          dependency: { file: "./button" },
          importPath: "./button",
          exportName: "*"
        }
      });
      expect(
        parsedModule.unsupportedExportStars[0]?.diagnostic.message
      ).toContain(`export * from "./button" is unsupported`);
      expect(
        getStaticCssModuleCacheInstrumentation(cache).parseCountByFile
      ).toEqual(new Map([[stylesId, 1]]));
    });
  });
}
