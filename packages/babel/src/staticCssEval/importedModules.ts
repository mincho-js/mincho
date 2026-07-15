import { transformSync, types as t } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";
import {
  getStaticObjectMemberValue,
  getStaticObjectPropertyName,
  getUnsupportedLiteralReason
} from "./ast.js";
import {
  createStaticCssEvalCandidate,
  unwrapTransparentCssRuleExpression
} from "./candidates.js";
import { createStaticCssEvalDiagnostic } from "./diagnostics.js";
import {
  enforceStaticCssEvalLiteralNodeCount,
  enforceStaticCssEvalObjectArrayRecursionDepth,
  enforceStaticCssEvalSourceSize
} from "./limits.js";
import {
  getStaticCssEvalConstBindingInitExpression,
  hasStaticCssEvalBindingMutation
} from "./sameFile.js";
import type {
  StaticCssEvalDiagnostic,
  StaticCssEvalExportName,
  StaticCssEvalProvider,
  StaticCssEvalQuery,
  StaticCssEvalResult,
  StaticCssEvalSourceLocation,
  StaticCssEvalUnsupportedReason,
  StaticCssLiteral,
  StaticCssEvalModuleRecord
} from "./types.js";

export type ImportedStaticCssEvalImportBinding =
  | {
      kind: "default";
      localName: string;
      importPath: string;
      importedName: "default";
    }
  | {
      kind: "named";
      localName: string;
      importPath: string;
      importedName: string;
    }
  | {
      kind: "namespace";
      localName: string;
      importPath: string;
    };

export type ImportedStaticCssEvalExportBinding =
  | {
      kind: "local";
      exportName: StaticCssEvalExportName;
      localName: string;
    }
  | {
      kind: "expression";
      exportName: StaticCssEvalExportName;
      expression: t.Expression;
    }
  | {
      kind: "unsupported";
      exportName: StaticCssEvalExportName;
      reason: StaticCssEvalUnsupportedReason;
      detail: string;
    };

type ImportedStaticCssEvalResolutionResult =
  | { kind: "not-candidate" }
  | { kind: "resolved"; value: StaticCssLiteral }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic };

interface ImportedStaticCssEvalContext {
  owner: StaticCssEvalSourceLocation;
  dependency: StaticCssEvalSourceLocation;
  importPath: string;
  exportName: StaticCssEvalExportName;
  memberPath: string[];
}

interface StaticCssLiteralValidationState {
  count: number;
}

export interface ImportedStaticCssEvalLoadedModule {
  id: string;
  source: string;
  realpath?: string;
  sourceHash?: string;
  version?: string | number;
}

export interface ImportedStaticCssEvalImportResolution {
  importerId: string;
  importPath: string;
  resolvedId: string;
}

export interface ImportedStaticCssEvalModuleRecord extends StaticCssEvalModuleRecord {
  source: string;
  imports: ReadonlyMap<string, ImportedStaticCssEvalImportBinding>;
  exports: ReadonlyMap<
    StaticCssEvalExportName,
    ImportedStaticCssEvalExportBinding
  >;
  exportAllReexportSources: readonly string[];
  programPath: NodePath<t.Program>;
}

export interface CreateImportedStaticCssEvalProviderOptions {
  modules: readonly ImportedStaticCssEvalLoadedModule[];
  importResolutions: readonly ImportedStaticCssEvalImportResolution[];
  moduleRecords?: readonly ImportedStaticCssEvalModuleRecord[];
}

export type ResolveImportedStaticCssEvalExpressionResult =
  | { kind: "not-candidate" }
  | { kind: "resolved"; expression: t.ObjectExpression | t.ArrayExpression }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic };

const importResolutionKeySeparator = "\0";

export function createImportedStaticCssEvalProvider(
  options: CreateImportedStaticCssEvalProviderOptions
): StaticCssEvalProvider {
  const resolver = new ImportedStaticCssEvalResolver(options);

  return {
    getResolvedCssValue(query) {
      return resolver.resolve(query);
    }
  };
}

export function createImportedStaticCssEvalModuleRecord(
  loadedModule: ImportedStaticCssEvalLoadedModule
): ImportedStaticCssEvalModuleRecord {
  const programPathRef: { current?: NodePath<t.Program> } = {};
  const isTypeScript = /\.[cm]?tsx?$/.test(loadedModule.id);
  const isJsx = /\.[jt]sx$/.test(loadedModule.id);
  const captureProgramPathPlugin: PluginObj = {
    visitor: {
      Program(path: NodePath<t.Program>) {
        programPathRef.current = path;
        path.stop();
      }
    }
  };

  transformSync(loadedModule.source, {
    filename: loadedModule.id,
    ast: true,
    code: false,
    sourceType: "module",
    configFile: false,
    babelrc: false,
    parserOpts: {
      plugins: [
        ...(isJsx ? (["jsx"] as const) : []),
        ...(isTypeScript ? (["typescript"] as const) : [])
      ]
    },
    plugins: [captureProgramPathPlugin]
  });

  const capturedProgramPath = programPathRef.current;

  if (!capturedProgramPath) {
    throw new Error(
      `Failed to create static css module scope ${loadedModule.id}`
    );
  }

  const imports = new Map<string, ImportedStaticCssEvalImportBinding>();
  const exports = new Map<
    StaticCssEvalExportName,
    ImportedStaticCssEvalExportBinding
  >();
  const exportAllReexportSources: string[] = [];

  for (const statement of capturedProgramPath.node.body) {
    collectModuleImportBindings(statement, imports);
    collectModuleExportBindings(statement, exports, exportAllReexportSources);
  }

  return {
    id: loadedModule.id,
    realpath: loadedModule.realpath ?? loadedModule.id,
    sourceHash:
      loadedModule.sourceHash ?? `inline:${loadedModule.source.length}`,
    ...(loadedModule.version !== undefined
      ? { version: loadedModule.version }
      : {}),
    dependencies: [],
    source: loadedModule.source,
    imports,
    exports,
    exportAllReexportSources,
    programPath: capturedProgramPath
  };
}

export function resolveImportedStaticCssEvalExpression(options: {
  expression: t.Expression;
  ownerFile: string;
  provider?: StaticCssEvalProvider;
  allowUnsupportedSourceFallback?: boolean;
}): ResolveImportedStaticCssEvalExpressionResult {
  if (!options.provider) {
    return { kind: "not-candidate" };
  }

  const candidate = createStaticCssEvalCandidate(
    options.expression,
    options.ownerFile
  );

  if (!candidate?.bindingName) {
    return { kind: "not-candidate" };
  }

  const result = options.provider.getResolvedCssValue(candidate);

  if (result.kind === "not-candidate") {
    return { kind: "not-candidate" };
  }

  if (result.kind === "error") {
    if (
      options.allowUnsupportedSourceFallback === true &&
      result.diagnostic.reason === "reexport-or-barrel"
    ) {
      return { kind: "not-candidate" };
    }

    return { kind: "error", diagnostic: result.diagnostic };
  }

  if (!isStaticCssRuleLiteralValue(result.value)) {
    return { kind: "not-candidate" };
  }

  const expression = createStaticCssLiteralExpression(result.value);

  return t.isObjectExpression(expression) || t.isArrayExpression(expression)
    ? { kind: "resolved", expression }
    : { kind: "not-candidate" };
}

export function findUnsupportedImportedStaticCssEvalReferenceDiagnostic(options: {
  expression: t.Expression;
  ownerFile: string;
  provider?: StaticCssEvalProvider;
}): StaticCssEvalDiagnostic | null {
  const { provider } = options;

  if (!provider) {
    return null;
  }

  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );

  if (t.isObjectExpression(unwrappedExpression)) {
    return findUnsupportedImportedObjectReferenceDiagnostic(
      unwrappedExpression,
      { ownerFile: options.ownerFile, provider }
    );
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return findUnsupportedImportedArrayReferenceDiagnostic(
      unwrappedExpression,
      { ownerFile: options.ownerFile, provider }
    );
  }

  return null;
}

export function createStaticCssLiteralExpression(
  value: StaticCssLiteral
): t.Expression {
  if (Array.isArray(value)) {
    return t.arrayExpression(value.map(createStaticCssLiteralExpression));
  }

  if (value && typeof value === "object") {
    return t.objectExpression(
      Object.entries(value).map(([key, propertyValue]) =>
        t.objectProperty(
          t.isValidIdentifier(key) ? t.identifier(key) : t.stringLiteral(key),
          createStaticCssLiteralExpression(propertyValue)
        )
      )
    );
  }

  if (typeof value === "string") {
    return t.stringLiteral(value);
  }

  if (typeof value === "number") {
    return t.numericLiteral(value);
  }

  if (typeof value === "boolean") {
    return t.booleanLiteral(value);
  }

  return t.nullLiteral();
}

class ImportedStaticCssEvalResolver {
  readonly #modules = new Map<string, ImportedStaticCssEvalLoadedModule>();
  readonly #records = new Map<string, ImportedStaticCssEvalModuleRecord>();
  readonly #importResolutions = new Map<string, string>();

  constructor(options: CreateImportedStaticCssEvalProviderOptions) {
    for (const loadedModule of options.modules) {
      this.#modules.set(loadedModule.id, loadedModule);
    }

    for (const moduleRecord of options.moduleRecords ?? []) {
      this.#records.set(moduleRecord.id, moduleRecord);
    }

    for (const resolution of options.importResolutions) {
      this.#importResolutions.set(
        createImportResolutionKey(resolution.importerId, resolution.importPath),
        resolution.resolvedId
      );
    }
  }

  resolve(query: StaticCssEvalQuery): StaticCssEvalResult {
    if (!query.bindingName) {
      return { kind: "not-candidate" };
    }

    const ownerRecord = this.#getModuleRecord(query.importerId);

    if (!ownerRecord) {
      return { kind: "not-candidate" };
    }

    const importBinding = ownerRecord.imports.get(query.bindingName);

    if (!importBinding || importBinding.kind === "namespace") {
      return { kind: "not-candidate" };
    }

    const owner = createQueryOwnerLocation(query);
    const resolvedId = this.#resolveImport(
      query.importerId,
      importBinding.importPath
    );

    if (!resolvedId) {
      const diagnostic = createImportedStaticCssEvalDiagnostic({
        owner,
        dependency: { file: importBinding.importPath },
        importPath: importBinding.importPath,
        exportName: importBinding.importedName,
        memberPath: query.memberPath ?? [],
        code: "failed-project-local-dependency",
        reason: "failed-project-local-dependency",
        detail: `failed to resolve project-local dependency ${importBinding.importPath}`
      });

      return {
        kind: "error",
        diagnostic,
        dependencies: []
      };
    }

    const dependency = { file: resolvedId };
    const loadedModule = this.#modules.get(resolvedId);

    if (!loadedModule) {
      const diagnostic = createImportedStaticCssEvalDiagnostic({
        owner,
        dependency,
        importPath: importBinding.importPath,
        exportName: importBinding.importedName,
        memberPath: query.memberPath ?? [],
        code: "failed-project-local-dependency",
        reason: "failed-project-local-dependency",
        detail: `failed to load project-local dependency ${resolvedId}`
      });

      return {
        kind: "error",
        diagnostic,
        dependencies: [resolvedId]
      };
    }

    const sourceSizeResult = enforceStaticCssEvalSourceSize({
      owner,
      dependency,
      importPath: importBinding.importPath,
      exportName: importBinding.importedName,
      memberPath: query.memberPath,
      source: loadedModule.source
    });

    if (!sourceSizeResult.ok) {
      return {
        kind: "error",
        diagnostic: sourceSizeResult.diagnostic,
        dependencies: [resolvedId]
      };
    }

    const dependencyRecord = this.#getModuleRecord(resolvedId);

    if (!dependencyRecord) {
      const diagnostic = createImportedStaticCssEvalDiagnostic({
        owner,
        dependency,
        importPath: importBinding.importPath,
        exportName: importBinding.importedName,
        memberPath: query.memberPath ?? [],
        code: "failed-project-local-dependency",
        reason: "failed-project-local-dependency",
        detail: `failed to parse project-local dependency ${resolvedId}`
      });

      return {
        kind: "error",
        diagnostic,
        dependencies: [resolvedId]
      };
    }

    const context: ImportedStaticCssEvalContext = {
      owner,
      dependency,
      importPath: importBinding.importPath,
      exportName: importBinding.importedName,
      memberPath: [...(query.memberPath ?? [])]
    };
    const result = resolveImportedModuleExport(dependencyRecord, context);

    if (result.kind === "not-candidate") {
      return { kind: "not-candidate" };
    }

    if (result.kind === "error") {
      return {
        kind: "error",
        diagnostic: result.diagnostic,
        dependencies: [resolvedId]
      };
    }

    return {
      kind: "resolved",
      value: result.value,
      dependencies: [resolvedId]
    };
  }

  #resolveImport(importerId: string, importPath: string): string | null {
    return (
      this.#importResolutions.get(
        createImportResolutionKey(importerId, importPath)
      ) ?? (this.#modules.has(importPath) ? importPath : null)
    );
  }

  #getModuleRecord(id: string): ImportedStaticCssEvalModuleRecord | null {
    const cachedRecord = this.#records.get(id);

    if (cachedRecord) {
      return cachedRecord;
    }

    const loadedModule = this.#modules.get(id);

    if (!loadedModule) {
      return null;
    }

    try {
      const record = createImportedStaticCssEvalModuleRecord(loadedModule);
      this.#records.set(id, record);
      return record;
    } catch {
      return null;
    }
  }
}

function collectModuleImportBindings(
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

function collectModuleExportBindings(
  statement: t.Statement,
  exports: Map<StaticCssEvalExportName, ImportedStaticCssEvalExportBinding>,
  exportAllReexportSources: string[]
): void {
  if (t.isExportAllDeclaration(statement)) {
    exportAllReexportSources.push(statement.source.value);
    return;
  }

  if (t.isExportDefaultDeclaration(statement)) {
    collectDefaultExportBinding(statement, exports);
    return;
  }

  if (
    !t.isExportNamedDeclaration(statement) ||
    statement.exportKind === "type"
  ) {
    return;
  }

  if (statement.source) {
    collectReexportBindings(statement, exports);
    return;
  }

  if (statement.declaration) {
    collectDeclaredExportBindings(statement.declaration, exports);
    return;
  }

  for (const specifier of statement.specifiers) {
    if (!t.isExportSpecifier(specifier) || specifier.exportKind === "type") {
      continue;
    }

    const localName = getModuleStringName(specifier.local);
    const exportName = getModuleStringName(specifier.exported);

    if (localName && exportName) {
      exports.set(exportName, {
        kind: "local",
        exportName,
        localName
      });
    }
  }
}

function collectDefaultExportBinding(
  statement: t.ExportDefaultDeclaration,
  exports: Map<StaticCssEvalExportName, ImportedStaticCssEvalExportBinding>
): void {
  const { declaration } = statement;

  if (t.isIdentifier(declaration)) {
    exports.set("default", {
      kind: "local",
      exportName: "default",
      localName: declaration.name
    });
    return;
  }

  if (t.isExpression(declaration)) {
    exports.set("default", {
      kind: "expression",
      exportName: "default",
      expression: declaration
    });
    return;
  }

  exports.set("default", {
    kind: "unsupported",
    exportName: "default",
    reason: "function-or-call",
    detail: "default export declaration is not a static expression"
  });
}

function collectReexportBindings(
  statement: t.ExportNamedDeclaration,
  exports: Map<StaticCssEvalExportName, ImportedStaticCssEvalExportBinding>
): void {
  for (const specifier of statement.specifiers) {
    if (t.isExportSpecifier(specifier)) {
      const exportName = getModuleStringName(specifier.exported);

      if (exportName) {
        exports.set(exportName, {
          kind: "unsupported",
          exportName,
          reason: "reexport-or-barrel",
          detail: `export "${exportName}" uses unsupported reexport/barrel syntax`
        });
      }
      continue;
    }

    if (t.isExportNamespaceSpecifier(specifier)) {
      const exportName = getModuleStringName(specifier.exported);

      if (exportName) {
        exports.set(exportName, {
          kind: "unsupported",
          exportName,
          reason: "reexport-or-barrel",
          detail: `export "${exportName}" uses unsupported reexport/barrel syntax`
        });
      }
    }
  }
}

function collectDeclaredExportBindings(
  declaration: t.Declaration,
  exports: Map<StaticCssEvalExportName, ImportedStaticCssEvalExportBinding>
): void {
  if (t.isVariableDeclaration(declaration)) {
    for (const declarator of declaration.declarations) {
      if (!t.isIdentifier(declarator.id)) {
        continue;
      }

      if (declaration.kind !== "const") {
        exports.set(declarator.id.name, {
          kind: "unsupported",
          exportName: declarator.id.name,
          reason: "let-or-var-binding",
          detail: `export "${declarator.id.name}" is not a const binding`
        });
        continue;
      }

      exports.set(declarator.id.name, {
        kind: "local",
        exportName: declarator.id.name,
        localName: declarator.id.name
      });
    }
    return;
  }

  if (
    (t.isFunctionDeclaration(declaration) ||
      t.isClassDeclaration(declaration)) &&
    declaration.id
  ) {
    exports.set(declaration.id.name, {
      kind: "unsupported",
      exportName: declaration.id.name,
      reason: "function-or-call",
      detail: `export "${declaration.id.name}" is not a static const literal`
    });
  }
}

function resolveImportedModuleExport(
  record: ImportedStaticCssEvalModuleRecord,
  context: ImportedStaticCssEvalContext
): ImportedStaticCssEvalResolutionResult {
  const exportBinding = record.exports.get(context.exportName);

  if (!exportBinding) {
    if (record.exportAllReexportSources.length > 0) {
      return {
        kind: "error",
        diagnostic: createImportedStaticCssEvalDiagnostic({
          ...context,
          code: "unsupported-source",
          reason: "reexport-or-barrel",
          detail: `export "${formatExportName(
            context.exportName
          )}" may come from unsupported export * barrel syntax`
        })
      };
    }

    return { kind: "not-candidate" };
  }

  if (exportBinding.kind === "unsupported") {
    return {
      kind: "error",
      diagnostic: createImportedStaticCssEvalDiagnostic({
        ...context,
        code:
          exportBinding.reason === "reexport-or-barrel"
            ? "unsupported-source"
            : "unsupported-syntax",
        reason: exportBinding.reason,
        detail: exportBinding.detail
      })
    };
  }

  const localName =
    exportBinding.kind === "local" ? exportBinding.localName : null;
  const expression =
    exportBinding.kind === "expression"
      ? exportBinding.expression
      : getLocalConstBindingExpression(record, exportBinding.localName);

  if (!expression) {
    return { kind: "not-candidate" };
  }

  const memberExpression = resolveStaticObjectMemberPath(
    expression,
    context.memberPath
  );

  if (
    !memberExpression ||
    !isStaticCssRuleLiteralExpression(memberExpression)
  ) {
    return { kind: "not-candidate" };
  }

  if (localName && hasImportedStaticCssBindingMutation(record, localName)) {
    return {
      kind: "error",
      diagnostic: createImportedStaticCssEvalDiagnostic({
        ...context,
        code: "mutation-detected",
        reason: "mutated-binding",
        detail: `imported binding "${localName}" from "${context.importPath}" is mutated`
      })
    };
  }

  const literalResult = evaluateStaticCssLiteralExpression(
    memberExpression,
    context,
    { count: 0 },
    1
  );

  if (literalResult.kind === "error") {
    return literalResult;
  }

  return {
    kind: "resolved",
    value: literalResult.value
  };
}

function getLocalConstBindingExpression(
  record: ImportedStaticCssEvalModuleRecord,
  localName: string
): t.Expression | null {
  const binding = record.programPath.scope.getBinding(localName);

  return binding ? getStaticCssEvalConstBindingInitExpression(binding) : null;
}

function hasImportedStaticCssBindingMutation(
  record: ImportedStaticCssEvalModuleRecord,
  localName: string
): boolean {
  const binding = record.programPath.scope.getBinding(localName);

  return binding
    ? hasStaticCssEvalBindingMutation(record.programPath, binding)
    : false;
}

function resolveStaticObjectMemberPath(
  expression: t.Expression,
  memberPath: readonly string[]
): t.Expression | null {
  let currentExpression: t.Expression | null =
    unwrapTransparentCssRuleExpression(expression);

  for (const memberName of memberPath) {
    if (!currentExpression) {
      return null;
    }

    const unwrappedExpression =
      unwrapTransparentCssRuleExpression(currentExpression);

    if (!t.isObjectExpression(unwrappedExpression)) {
      return null;
    }

    currentExpression = getStaticObjectMemberValue(
      unwrappedExpression,
      memberName
    );
  }

  return currentExpression
    ? unwrapTransparentCssRuleExpression(currentExpression)
    : null;
}

function evaluateStaticCssLiteralExpression(
  expression: t.Expression,
  context: ImportedStaticCssEvalContext,
  state: StaticCssLiteralValidationState,
  depth: number
):
  | { kind: "resolved"; value: StaticCssLiteral }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);
  state.count += 1;

  const countResult = enforceImportedStaticCssEvalLiteralCount(context, state);

  if (countResult) {
    return { kind: "error", diagnostic: countResult };
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    const depthResult = enforceImportedStaticCssEvalDepth(context, depth);

    if (depthResult) {
      return { kind: "error", diagnostic: depthResult };
    }

    return evaluateStaticCssObjectExpression(
      unwrappedExpression,
      context,
      state,
      depth
    );
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    const depthResult = enforceImportedStaticCssEvalDepth(context, depth);

    if (depthResult) {
      return { kind: "error", diagnostic: depthResult };
    }

    return evaluateStaticCssArrayExpression(
      unwrappedExpression,
      context,
      state,
      depth
    );
  }

  if (t.isStringLiteral(unwrappedExpression)) {
    return { kind: "resolved", value: unwrappedExpression.value };
  }

  if (t.isNumericLiteral(unwrappedExpression)) {
    return { kind: "resolved", value: unwrappedExpression.value };
  }

  if (t.isBooleanLiteral(unwrappedExpression)) {
    return { kind: "resolved", value: unwrappedExpression.value };
  }

  if (t.isNullLiteral(unwrappedExpression)) {
    return { kind: "resolved", value: null };
  }

  if (
    t.isUnaryExpression(unwrappedExpression) &&
    (unwrappedExpression.operator === "+" ||
      unwrappedExpression.operator === "-") &&
    t.isNumericLiteral(unwrappedExpression.argument)
  ) {
    return {
      kind: "resolved",
      value:
        unwrappedExpression.operator === "-"
          ? -unwrappedExpression.argument.value
          : unwrappedExpression.argument.value
    };
  }

  if (
    t.isTemplateLiteral(unwrappedExpression) &&
    unwrappedExpression.expressions.length === 0
  ) {
    const [quasi] = unwrappedExpression.quasis;
    return {
      kind: "resolved",
      value: quasi?.value.cooked ?? quasi?.value.raw ?? ""
    };
  }

  return {
    kind: "error",
    diagnostic: createImportedStaticCssEvalDiagnostic({
      ...context,
      code: "unsupported-syntax",
      reason: getUnsupportedLiteralReason(unwrappedExpression),
      detail: `imported export "${formatExportName(
        context.exportName
      )}" contains unsupported ${unwrappedExpression.type}`
    })
  };
}

function evaluateStaticCssObjectExpression(
  expression: t.ObjectExpression,
  context: ImportedStaticCssEvalContext,
  state: StaticCssLiteralValidationState,
  depth: number
):
  | { kind: "resolved"; value: StaticCssLiteral }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  const value: Record<string, StaticCssLiteral> = {};

  for (const property of expression.properties) {
    if (t.isSpreadElement(property)) {
      return createStaticCssLiteralError(
        context,
        "object-or-array-spread",
        `imported export "${formatExportName(
          context.exportName
        )}" contains an object spread`
      );
    }

    if (!t.isObjectProperty(property)) {
      return createStaticCssLiteralError(
        context,
        "function-or-call",
        `imported export "${formatExportName(
          context.exportName
        )}" contains an object method`
      );
    }

    if (property.computed) {
      return createStaticCssLiteralError(
        context,
        "computed-object-key",
        `imported export "${formatExportName(
          context.exportName
        )}" contains a computed object key`
      );
    }

    if (!t.isExpression(property.value)) {
      return createStaticCssLiteralError(
        context,
        "unsupported-literal",
        `imported export "${formatExportName(
          context.exportName
        )}" contains a non-expression object value`
      );
    }

    const propertyName = getStaticObjectPropertyName(property.key);

    if (!propertyName) {
      return createStaticCssLiteralError(
        context,
        "unsupported-literal",
        `imported export "${formatExportName(
          context.exportName
        )}" contains an unsupported object key`
      );
    }

    const propertyResult = evaluateStaticCssLiteralExpression(
      property.value,
      context,
      state,
      depth + 1
    );

    if (propertyResult.kind === "error") {
      return propertyResult;
    }

    value[propertyName] = propertyResult.value;
  }

  return { kind: "resolved", value };
}

function evaluateStaticCssArrayExpression(
  expression: t.ArrayExpression,
  context: ImportedStaticCssEvalContext,
  state: StaticCssLiteralValidationState,
  depth: number
):
  | { kind: "resolved"; value: StaticCssLiteral }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  const value: StaticCssLiteral[] = [];

  for (const element of expression.elements) {
    if (!element) {
      return createStaticCssLiteralError(
        context,
        "unsupported-literal",
        `imported export "${formatExportName(
          context.exportName
        )}" contains an array hole`
      );
    }

    if (t.isSpreadElement(element)) {
      return createStaticCssLiteralError(
        context,
        "object-or-array-spread",
        `imported export "${formatExportName(
          context.exportName
        )}" contains an array spread`
      );
    }

    const elementResult = evaluateStaticCssLiteralExpression(
      element,
      context,
      state,
      depth + 1
    );

    if (elementResult.kind === "error") {
      return elementResult;
    }

    value.push(elementResult.value);
  }

  return { kind: "resolved", value };
}

function findUnsupportedImportedObjectReferenceDiagnostic(
  expression: t.ObjectExpression,
  options: {
    ownerFile: string;
    provider: StaticCssEvalProvider;
  }
): StaticCssEvalDiagnostic | null {
  for (const property of expression.properties) {
    if (!t.isObjectProperty(property) || !t.isExpression(property.value)) {
      continue;
    }

    const diagnostic = findUnsupportedImportedExpressionReferenceDiagnostic(
      property.value,
      options
    );

    if (diagnostic) {
      return diagnostic;
    }
  }

  return null;
}

function findUnsupportedImportedArrayReferenceDiagnostic(
  expression: t.ArrayExpression,
  options: {
    ownerFile: string;
    provider: StaticCssEvalProvider;
  }
): StaticCssEvalDiagnostic | null {
  for (const element of expression.elements) {
    if (!element || t.isSpreadElement(element)) {
      continue;
    }

    const diagnostic = findUnsupportedImportedExpressionReferenceDiagnostic(
      element,
      options
    );

    if (diagnostic) {
      return diagnostic;
    }
  }

  return null;
}

function findUnsupportedImportedExpressionReferenceDiagnostic(
  expression: t.Expression,
  options: {
    ownerFile: string;
    provider: StaticCssEvalProvider;
  }
): StaticCssEvalDiagnostic | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);
  const candidate = createStaticCssEvalCandidate(
    unwrappedExpression,
    options.ownerFile
  );

  if (candidate?.bindingName) {
    const result = options.provider.getResolvedCssValue(candidate);

    if (result.kind === "error") {
      return result.diagnostic;
    }
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    return findUnsupportedImportedObjectReferenceDiagnostic(
      unwrappedExpression,
      options
    );
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return findUnsupportedImportedArrayReferenceDiagnostic(
      unwrappedExpression,
      options
    );
  }

  return null;
}

function enforceImportedStaticCssEvalDepth(
  context: ImportedStaticCssEvalContext,
  depth: number
): StaticCssEvalDiagnostic | null {
  const result = enforceStaticCssEvalObjectArrayRecursionDepth({
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    recursionDepth: depth
  });

  return result.ok ? null : result.diagnostic;
}

function enforceImportedStaticCssEvalLiteralCount(
  context: ImportedStaticCssEvalContext,
  state: StaticCssLiteralValidationState
): StaticCssEvalDiagnostic | null {
  const result = enforceStaticCssEvalLiteralNodeCount({
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    literalNodeCount: state.count
  });

  return result.ok ? null : result.diagnostic;
}

function createStaticCssLiteralError(
  context: ImportedStaticCssEvalContext,
  reason: StaticCssEvalUnsupportedReason,
  detail: string
): { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  return {
    kind: "error",
    diagnostic: createImportedStaticCssEvalDiagnostic({
      ...context,
      code: "unsupported-syntax",
      reason,
      detail
    })
  };
}

function createImportedStaticCssEvalDiagnostic(
  options: ImportedStaticCssEvalContext & {
    code: StaticCssEvalDiagnostic["code"];
    reason: StaticCssEvalUnsupportedReason;
    detail: string;
  }
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    code: options.code,
    reason: options.reason,
    detail: options.detail,
    owner: options.owner,
    dependency: options.dependency,
    importPath: options.importPath,
    exportName: options.exportName,
    memberPath: options.memberPath,
    importChain: [
      options.owner.file,
      `${options.dependency.file}#${formatExportName(options.exportName)}${
        options.memberPath.length > 0 ? `.${options.memberPath.join(".")}` : ""
      }`
    ]
  });
}

function createQueryOwnerLocation(
  query: StaticCssEvalQuery
): StaticCssEvalSourceLocation {
  return {
    file: query.importerId,
    start: query.expressionStart,
    end: query.expressionEnd
  };
}

function getModuleStringName(
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

function isStaticCssRuleLiteralExpression(
  expression: t.Expression
): expression is t.ObjectExpression | t.ArrayExpression {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return (
    t.isObjectExpression(unwrappedExpression) ||
    t.isArrayExpression(unwrappedExpression)
  );
}

function isStaticCssRuleLiteralValue(
  value: StaticCssLiteral
): value is StaticCssLiteral[] | { [key: string]: StaticCssLiteral } {
  return value !== null && typeof value === "object";
}

function formatExportName(exportName: StaticCssEvalExportName): string {
  return exportName === null ? "<local>" : exportName;
}

function createImportResolutionKey(
  importerId: string,
  importPath: string
): string {
  return `${importerId}${importResolutionKeySeparator}${importPath}`;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const ownerId = "/project/src/App.tsx";
  const stylesId = "/project/src/styles.ts";
  const barrelId = "/project/src/barrel.ts";

  function createProvider(
    stylesSource: string,
    ownerSource = `import { button } from "./styles"; <div css={button} />;`,
    barrelSource = `export { button } from "./styles";`
  ): StaticCssEvalProvider {
    return createImportedStaticCssEvalProvider({
      modules: [
        { id: ownerId, source: ownerSource },
        { id: stylesId, source: stylesSource },
        {
          id: barrelId,
          source: barrelSource
        }
      ],
      importResolutions: [
        { importerId: ownerId, importPath: "./styles", resolvedId: stylesId },
        { importerId: ownerId, importPath: "./barrel", resolvedId: barrelId }
      ]
    });
  }

  function resolveFixture(
    provider: StaticCssEvalProvider,
    bindingName: string,
    memberPath: string[] = []
  ): StaticCssEvalResult {
    return provider.getResolvedCssValue({
      importerId: ownerId,
      expressionStart: 0,
      expressionEnd: bindingName.length,
      bindingName,
      ...(memberPath.length > 0 ? { memberPath } : {})
    });
  }

  describe("imported static css eval module records", () => {
    it("matches parser plugins to the loaded module extension", () => {
      expect(() =>
        createImportedStaticCssEvalModuleRecord({
          id: "/project/src/styles.ts",
          source: `export const value = <number>1;`
        })
      ).not.toThrow();

      expect(() =>
        createImportedStaticCssEvalModuleRecord({
          id: "/project/src/styles.js",
          source: `export const value: number = 1;`
        })
      ).toThrow();

      expect(() =>
        createImportedStaticCssEvalModuleRecord({
          id: "/project/src/styles.jsx",
          source: `export const value = <div />;`
        })
      ).not.toThrow();
    });

    it("resolves named, aliased, default object, default const, and same-module export aliases", () => {
      expect(
        resolveFixture(
          createProvider(`export const button = { color: "red" } as const;`),
          "button"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        dependencies: [stylesId]
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import { button as buttonStyle } from "./styles"; <div css={buttonStyle} />;`
          ),
          "buttonStyle"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "red" }
      });

      expect(
        resolveFixture(
          createProvider(
            `export default { color: "blue" } as const;`,
            `import styles from "./styles"; <div css={styles} />;`
          ),
          "styles"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "blue" }
      });

      expect(
        resolveFixture(
          createProvider(
            `const button = { color: "green" } as const; export default button;`,
            `import styles from "./styles"; <div css={styles} />;`
          ),
          "styles"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "green" }
      });

      expect(
        resolveFixture(
          createProvider(
            `const x = { color: "orange" } as const; export { x as y };`,
            `import { y } from "./styles"; <div css={y} />;`
          ),
          "y"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "orange" }
      });
    });

    it("resolves nested member paths over imported static objects", () => {
      expect(
        resolveFixture(
          createProvider(
            `export const styles = { button: { primary: { color: "red" } } } as const;`,
            `import { styles } from "./styles"; <div css={styles.button.primary} />;`
          ),
          "styles",
          ["button", "primary"]
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "red" }
      });
    });

    it("rejects reexports and exported const mutations deterministically", () => {
      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import { button } from "./barrel"; <div css={button} />;`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          code: "unsupported-source",
          reason: "reexport-or-barrel"
        },
        dependencies: [barrelId]
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import { button } from "./barrel"; <div css={button} />;`,
            `export * from "./styles";`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          code: "unsupported-source",
          reason: "reexport-or-barrel"
        },
        dependencies: [barrelId]
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const; button.color = "blue";`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          code: "mutation-detected",
          reason: "mutated-binding"
        },
        dependencies: [stylesId]
      });

      expect(
        resolveFixture(
          createProvider(
            `export const buttons = [{ color: "red" }] as const; buttons.push({ color: "blue" });`,
            `import { buttons } from "./styles"; <div css={buttons} />;`
          ),
          "buttons"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          code: "mutation-detected",
          reason: "mutated-binding"
        },
        dependencies: [stylesId]
      });
    });
  });
}
