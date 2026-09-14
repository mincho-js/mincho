import {
  internalStaticCssEvalLimits,
  type InternalImportedStaticCssEvalImportResolution as BabelImportedStaticCssEvalImportResolution,
  type InternalImportedStaticCssEvalLoadedModule as BabelImportedStaticCssEvalLoadedModule
} from "@mincho-js/babel";
import type {
  StaticCssEvalLoadedSource,
  StaticCssEvalResolvedDependency,
  StaticCssEvalResolverKind,
  StaticCssEvalSourceIdentity,
  StaticCssEvalSourceKind,
  StaticCssEvalSourceOrigin,
  StaticCssEvalSourceResolution,
  StaticCssEvalSourceUnsupportedReason
} from "./babel.js";
import { getStaticCssEvalSourceOrigin } from "./staticCssEvalSource.js";
import {
  internalGetStaticCssEvalQueryFlags as getStaticCssEvalQueryFlags,
  internalStripStaticCssEvalRequestQuery as stripStaticCssEvalQuery
} from "./staticCssEvalUtils.js";

export type ImportedStaticCssEvalLoadedModule =
  BabelImportedStaticCssEvalLoadedModule & {
    readonly sourceHash?: string;
    readonly version?: string | number;
    readonly resolverKind?: string;
  };

export type ImportedStaticCssEvalImportResolution =
  BabelImportedStaticCssEvalImportResolution & {
    readonly sourceHash?: string;
    readonly resolverKind?: string;
  };

export interface NormalizedStaticCssEvalSourceResolution {
  resolvedFile: string;
  canonicalModuleId: string;
  normalizedPathKey: string;
  resolverKind: StaticCssEvalResolverKind;
  realpath?: string;
  sourceIdentity?: StaticCssEvalSourceIdentity;
  sourceKind: StaticCssEvalSourceKind;
  sourceOrigin: StaticCssEvalSourceOrigin;
  unsupportedReason?: StaticCssEvalSourceUnsupportedReason;
  watchFiles?: readonly string[];
}

interface CreateLoadedModuleOptions {
  resolution?: NormalizedStaticCssEvalSourceResolution;
  sourceText?: string;
}

type PreparedStaticCssEvalLoadedSource =
  | {
      kind: "source";
      sourceText: string;
      loadedSource: StaticCssEvalLoadedSource;
    }
  | {
      kind: "unsupported";
      loadedSource: StaticCssEvalLoadedSource;
    };

const STATIC_CSS_EVAL_PREPASS_MAX_SOURCE_BYTES =
  internalStaticCssEvalLimits.maxLoadedDependencySourceBytes;

const STATIC_CSS_EVAL_PREPASS_RESERVED_EXPORT_NAMES = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield"
]);

export function createLoadedModule(
  id: string,
  loadedSource: StaticCssEvalLoadedSource,
  options: CreateLoadedModuleOptions = {}
): ImportedStaticCssEvalLoadedModule {
  const sourceText =
    options.sourceText ?? getLoadedSourceText(id, loadedSource);

  const sourceIdentity = createLoadedSourceIdentity(
    sourceText,
    loadedSource,
    options.resolution
  );

  return {
    id,
    source: sourceText,
    realpath: loadedSource.realpath ?? options.resolution?.realpath,
    sourceHash: sourceIdentity.sourceHash,
    version: sourceIdentity.version,
    ...createLoadedModuleSourceMetadata(loadedSource, options.resolution)
  };
}

export function createStaticCssEvalPrepassImportResolution(
  importerId: string,
  importPath: string,
  resolution: NormalizedStaticCssEvalSourceResolution,
  loadedSource?: StaticCssEvalLoadedSource
): ImportedStaticCssEvalImportResolution {
  const canonicalModuleId =
    loadedSource?.canonicalModuleId ?? resolution.canonicalModuleId;

  const normalizedPathKey =
    loadedSource?.normalizedPathKey ?? resolution.normalizedPathKey;

  const sourceKind = loadedSource?.sourceKind ?? resolution.sourceKind;
  const sourceOrigin =
    loadedSource?.sourceOrigin ??
    (loadedSource?.sourceKind
      ? getStaticCssEvalSourceOrigin(loadedSource.sourceKind)
      : resolution.sourceOrigin);

  const unsupportedReason =
    loadedSource?.unsupportedReason ?? resolution.unsupportedReason;

  const watchFiles = loadedSource?.watchFiles ?? resolution.watchFiles;
  const loadedSourceText = loadedSource
    ? (loadedSource.sourceText ?? loadedSource.source)
    : undefined;

  const sourceIdentity = loadedSource
    ? loadedSourceText === undefined
      ? (normalizeStaticCssEvalSourceIdentity(
          loadedSource.sourceIdentity,
          loadedSource.sourceHash,
          loadedSource.version
        ) ?? resolution.sourceIdentity)
      : createLoadedSourceIdentity(loadedSourceText, loadedSource, resolution)
    : resolution.sourceIdentity;

  const resolverKind = loadedSource?.resolverKind ?? resolution.resolverKind;

  return {
    importerId,
    importPath,
    resolvedId: resolution.resolvedFile,
    canonicalModuleId,
    normalizedPathKey,
    sourceKind,
    sourceOrigin,
    ...(sourceIdentity?.sourceHash
      ? { sourceHash: sourceIdentity.sourceHash }
      : {}),
    ...(sourceIdentity?.version !== undefined
      ? { version: sourceIdentity.version }
      : {}),
    resolverKind,
    ...(unsupportedReason ? { unsupportedReason } : {}),
    ...(watchFiles ? { watchFiles: [...watchFiles] } : {})
  };
}

export function createUnresolvedStaticCssEvalSourceResolution(
  importPath: string
): NormalizedStaticCssEvalSourceResolution {
  const unresolvedId = `unresolved:${importPath}`;

  return {
    resolvedFile: importPath,
    canonicalModuleId: unresolvedId,
    normalizedPathKey: unresolvedId,
    resolverKind: "source-provider",
    sourceKind: "unresolved",
    sourceOrigin: "unresolved",
    unsupportedReason: "unresolved"
  };
}

export function createLoadFailureStaticCssEvalSourceResolution(
  resolution: NormalizedStaticCssEvalSourceResolution
): NormalizedStaticCssEvalSourceResolution {
  if (
    resolution.sourceKind === "external-no-source" ||
    resolution.sourceKind === "provider-virtual" ||
    resolution.sourceKind === "unsupported-source-shape"
  ) {
    return resolution;
  }

  return {
    ...resolution,
    sourceKind: "unresolved",
    sourceOrigin: "unresolved",
    unsupportedReason: resolution.unsupportedReason ?? "unresolved"
  };
}

function createLoadedModuleSourceMetadata(
  loadedSource: StaticCssEvalLoadedSource,
  resolution: NormalizedStaticCssEvalSourceResolution | undefined
): Pick<
  ImportedStaticCssEvalLoadedModule,
  | "canonicalModuleId"
  | "normalizedPathKey"
  | "sourceKind"
  | "sourceOrigin"
  | "unsupportedReason"
  | "sourceHash"
  | "version"
  | "resolverKind"
  | "watchFiles"
> {
  const sourceKind = loadedSource.sourceKind ?? resolution?.sourceKind;
  const sourceOrigin =
    loadedSource.sourceOrigin ??
    (loadedSource.sourceKind
      ? getStaticCssEvalSourceOrigin(loadedSource.sourceKind)
      : resolution?.sourceOrigin);

  const canonicalModuleId =
    loadedSource.canonicalModuleId ?? resolution?.canonicalModuleId;

  const normalizedPathKey =
    loadedSource.normalizedPathKey ?? resolution?.normalizedPathKey;

  const unsupportedReason =
    loadedSource.unsupportedReason ?? resolution?.unsupportedReason;

  const watchFiles = loadedSource.watchFiles ?? resolution?.watchFiles;
  const sourceIdentity = normalizeStaticCssEvalSourceIdentity(
    loadedSource.sourceIdentity,
    loadedSource.sourceHash,
    loadedSource.version
  );

  const sourceHash =
    sourceIdentity?.sourceHash ?? resolution?.sourceIdentity?.sourceHash;

  const version =
    sourceIdentity?.version ?? resolution?.sourceIdentity?.version;

  const resolverKind = loadedSource.resolverKind ?? resolution?.resolverKind;

  return {
    ...(canonicalModuleId ? { canonicalModuleId } : {}),
    ...(normalizedPathKey ? { normalizedPathKey } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(sourceOrigin ? { sourceOrigin } : {}),
    ...(unsupportedReason ? { unsupportedReason } : {}),
    ...(sourceHash ? { sourceHash } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(resolverKind ? { resolverKind } : {}),
    ...(watchFiles ? { watchFiles: [...watchFiles] } : {})
  };
}

export function prepareStaticCssEvalLoadedSource(
  id: string,
  loadedSource: StaticCssEvalLoadedSource,
  resolution: NormalizedStaticCssEvalSourceResolution
): PreparedStaticCssEvalLoadedSource {
  const sourceKind = loadedSource.sourceKind ?? resolution.sourceKind;
  const sourceText = loadedSource.sourceText ?? loadedSource.source;

  if (sourceKind === "unsupported-source-shape") {
    return {
      kind: "unsupported",
      loadedSource: createUnsupportedStaticCssEvalLoadedSource(
        loadedSource,
        loadedSource.unsupportedReason ?? "unsupported-source-shape"
      )
    };
  }

  if (sourceText === undefined) {
    return {
      kind: "unsupported",
      loadedSource: createUnsupportedStaticCssEvalLoadedSource(
        loadedSource,
        "unsupported-source-shape"
      )
    };
  }

  if (sourceKind === "static-data") {
    return prepareStaticCssEvalStaticDataSource({
      id,
      sourceText,
      loadedSource,
      resolution
    });
  }

  return prepareStaticCssEvalSourceText(sourceText, loadedSource);
}

function prepareStaticCssEvalSourceText(
  sourceText: string,
  loadedSource: StaticCssEvalLoadedSource
): PreparedStaticCssEvalLoadedSource {
  if (isStaticCssEvalSourceOverByteLimit(sourceText)) {
    return {
      kind: "unsupported",
      loadedSource: createUnsupportedStaticCssEvalLoadedSource(
        loadedSource,
        "source-size-limit-exceeded"
      )
    };
  }

  return { kind: "source", sourceText, loadedSource };
}

function prepareStaticCssEvalStaticDataSource(options: {
  id: string;
  sourceText: string;
  loadedSource: StaticCssEvalLoadedSource;
  resolution: NormalizedStaticCssEvalSourceResolution;
}): PreparedStaticCssEvalLoadedSource {
  const sourceIds = createStaticCssEvalSourceIds(
    options.id,
    options.resolution
  );

  if (isStaticCssEvalWasmRuntimeSource(sourceIds)) {
    return {
      kind: "unsupported",
      loadedSource: createUnsupportedStaticCssEvalLoadedSource(
        options.loadedSource,
        hasStaticCssEvalQueryFlag(sourceIds, "init")
          ? "runtime-wasm-init"
          : "runtime-wasm-module"
      )
    };
  }

  if (isStaticCssEvalStringDataSource(sourceIds)) {
    const esmSource = createStaticCssEvalStringDataModuleSource(
      options.sourceText
    );

    return prepareStaticCssEvalSourceText(esmSource, {
      ...options.loadedSource,
      sourceText: esmSource
    });
  }

  if (isStaticCssEvalJsonSource(sourceIds)) {
    return prepareStaticCssEvalJsonDataSource(
      options.sourceText,
      options.loadedSource
    );
  }

  return prepareStaticCssEvalSourceText(
    options.sourceText,
    options.loadedSource
  );
}

function prepareStaticCssEvalJsonDataSource(
  sourceText: string,
  loadedSource: StaticCssEvalLoadedSource
): PreparedStaticCssEvalLoadedSource {
  let value: unknown;

  try {
    value = JSON.parse(sourceText);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        kind: "unsupported",
        loadedSource: createUnsupportedStaticCssEvalLoadedSource(
          loadedSource,
          "invalid-json-data"
        )
      };
    }

    throw error;
  }

  const esmSource = createStaticCssEvalJsonDataModuleSource(value);

  if (!esmSource) {
    return {
      kind: "unsupported",
      loadedSource: createUnsupportedStaticCssEvalLoadedSource(
        loadedSource,
        "non-literal-loader-output"
      )
    };
  }

  return prepareStaticCssEvalSourceText(esmSource, {
    ...loadedSource,
    sourceText: esmSource
  });
}

function createStaticCssEvalJsonDataModuleSource(
  value: unknown
): string | null {
  const defaultLiteral = JSON.stringify(value);

  if (typeof defaultLiteral !== "string") {
    return null;
  }

  const declarations = [`export default ${defaultLiteral};`];

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, itemValue] of Object.entries(value)) {
      if (!isStaticCssEvalValidNamedExport(key)) {
        continue;
      }

      const itemLiteral = JSON.stringify(itemValue);

      if (typeof itemLiteral === "string") {
        declarations.push(`export const ${key} = ${itemLiteral};`);
      }
    }
  }

  return `${declarations.join("\n")}\n`;
}

function createStaticCssEvalStringDataModuleSource(value: string): string {
  return `export default ${JSON.stringify(value)};\n`;
}

export function createUnsupportedStaticCssEvalLoadedSource(
  loadedSource: StaticCssEvalLoadedSource,
  unsupportedReason: StaticCssEvalSourceUnsupportedReason
): StaticCssEvalLoadedSource {
  return {
    ...loadedSource,
    sourceKind: "unsupported-source-shape",
    sourceOrigin: "unsupported",
    unsupportedReason: loadedSource.unsupportedReason ?? unsupportedReason
  };
}

function createStaticCssEvalSourceIds(
  id: string,
  resolution: NormalizedStaticCssEvalSourceResolution
): string[] {
  return [
    ...new Set([
      id,
      resolution.resolvedFile,
      resolution.canonicalModuleId,
      resolution.normalizedPathKey
    ])
  ];
}

function isStaticCssEvalJsonSource(sourceIds: readonly string[]): boolean {
  return sourceIds.some((sourceId) =>
    stripStaticCssEvalQuery(sourceId).endsWith(".json")
  );
}

function isStaticCssEvalStringDataSource(
  sourceIds: readonly string[]
): boolean {
  return (
    hasStaticCssEvalQueryFlag(sourceIds, "raw") ||
    hasStaticCssEvalQueryFlag(sourceIds, "url")
  );
}

function isStaticCssEvalWasmRuntimeSource(
  sourceIds: readonly string[]
): boolean {
  return sourceIds.some(
    (sourceId) =>
      stripStaticCssEvalQuery(sourceId).endsWith(".wasm") &&
      !hasStaticCssEvalQueryFlag([sourceId], "raw") &&
      !hasStaticCssEvalQueryFlag([sourceId], "url")
  );
}

function hasStaticCssEvalQueryFlag(
  sourceIds: readonly string[],
  flag: string
): boolean {
  return sourceIds.some((sourceId) =>
    getStaticCssEvalQueryFlags(sourceId).includes(flag)
  );
}

function isStaticCssEvalValidNamedExport(name: string): boolean {
  return (
    /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(name) &&
    !STATIC_CSS_EVAL_PREPASS_RESERVED_EXPORT_NAMES.has(name)
  );
}

function isStaticCssEvalSourceOverByteLimit(sourceText: string): boolean {
  return (
    new TextEncoder().encode(sourceText).byteLength >
    STATIC_CSS_EVAL_PREPASS_MAX_SOURCE_BYTES
  );
}

function getLoadedSourceText(
  id: string,
  loadedSource: StaticCssEvalLoadedSource
): string {
  const sourceText = loadedSource.sourceText ?? loadedSource.source;

  if (sourceText === undefined) {
    throw new Error(
      `Static css eval source provider did not return source for ${id}`
    );
  }

  return sourceText;
}

export function normalizeStaticCssEvalSourceResolution(
  resolution: StaticCssEvalSourceResolution
): NormalizedStaticCssEvalSourceResolution {
  const resolvedFile = resolution.resolvedFile ?? resolution.id;

  if (!resolvedFile) {
    throw new Error(
      "Static css eval source resolution requires resolvedFile or id"
    );
  }

  const canonicalModuleId =
    resolution.canonicalModuleId ?? resolution.id ?? resolvedFile;

  const normalizedPathKey =
    resolution.normalizedPathKey ?? canonicalModuleId ?? resolvedFile;

  const sourceKind = resolution.sourceKind ?? "project-source";

  return {
    resolvedFile,
    canonicalModuleId,
    normalizedPathKey,
    resolverKind: resolution.resolverKind ?? "source-provider",
    realpath: resolution.realpath,
    sourceIdentity: normalizeStaticCssEvalSourceIdentity(
      resolution.sourceIdentity,
      resolution.sourceHash,
      resolution.version
    ),
    sourceKind,
    sourceOrigin:
      resolution.sourceOrigin ?? getStaticCssEvalSourceOrigin(sourceKind),
    unsupportedReason: resolution.unsupportedReason,
    ...(resolution.watchFiles ? { watchFiles: [...resolution.watchFiles] } : {})
  };
}

function normalizeStaticCssEvalSourceIdentity(
  sourceIdentity: StaticCssEvalSourceIdentity | undefined,
  sourceHash: string | undefined,
  version: string | number | undefined
): StaticCssEvalSourceIdentity | undefined {
  const normalizedSourceHash = sourceIdentity?.sourceHash ?? sourceHash;
  const normalizedVersion = sourceIdentity?.version ?? version;

  if (normalizedSourceHash === undefined && normalizedVersion === undefined) {
    return undefined;
  }

  return {
    ...(normalizedSourceHash !== undefined
      ? { sourceHash: normalizedSourceHash }
      : {}),
    ...(normalizedVersion !== undefined ? { version: normalizedVersion } : {})
  };
}

function createLoadedSourceIdentity(
  sourceText: string,
  loadedSource: StaticCssEvalLoadedSource,
  resolution?: NormalizedStaticCssEvalSourceResolution
): Required<Pick<StaticCssEvalSourceIdentity, "sourceHash">> &
  Pick<StaticCssEvalSourceIdentity, "version"> {
  const sourceIdentity = normalizeStaticCssEvalSourceIdentity(
    loadedSource.sourceIdentity,
    loadedSource.sourceHash,
    loadedSource.version
  );

  const sourceHash =
    sourceIdentity?.sourceHash ??
    resolution?.sourceIdentity?.sourceHash ??
    createStaticCssEvalSourceTextHash(sourceText);

  const version =
    sourceIdentity?.version ?? resolution?.sourceIdentity?.version;

  return {
    sourceHash,
    ...(version !== undefined ? { version } : {})
  };
}

export function createStaticCssEvalResolvedDependency(
  importerId: string,
  specifier: string,
  resolution: NormalizedStaticCssEvalSourceResolution,
  loaded: boolean,
  loadedSource?: StaticCssEvalLoadedSource
): StaticCssEvalResolvedDependency {
  const sourceText = loadedSource
    ? (loadedSource.sourceText ?? loadedSource.source)
    : undefined;

  const sourceIdentity = loadedSource
    ? createLoadedSourceIdentity(sourceText ?? "", loadedSource, resolution)
    : resolution.sourceIdentity;

  const sourceKind = loadedSource?.sourceKind ?? resolution.sourceKind;
  const sourceOrigin =
    loadedSource?.sourceOrigin ??
    (loadedSource?.sourceKind
      ? getStaticCssEvalSourceOrigin(loadedSource.sourceKind)
      : resolution.sourceOrigin);

  const unsupportedReason =
    loadedSource?.unsupportedReason ?? resolution.unsupportedReason;

  const watchFiles = loadedSource?.watchFiles ?? resolution.watchFiles;

  return {
    importerId,
    specifier,
    resolvedFile: resolution.resolvedFile,
    canonicalModuleId: resolution.canonicalModuleId,
    normalizedPathKey: resolution.normalizedPathKey,
    resolverKind: resolution.resolverKind,
    loaded,
    ...(sourceIdentity ? { sourceIdentity } : {}),
    sourceKind,
    sourceOrigin,
    ...(unsupportedReason ? { unsupportedReason } : {}),
    ...(watchFiles ? { watchFiles: [...watchFiles] } : {})
  };
}

function createStaticCssEvalSourceTextHash(sourceText: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < sourceText.length; index += 1) {
    hash ^= sourceText.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}:${sourceText.length}`;
}
