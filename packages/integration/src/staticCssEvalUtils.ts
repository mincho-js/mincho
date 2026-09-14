import * as fs from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BabelTransformResult,
  StaticCssEvalSourceIdentity,
  StaticCssEvalSourceResolution
} from "./babel.js";
import {
  createStaticCssEvalSourceHash,
  getExistingRealpath,
  hasNodeModulesSegment,
  isPathInsideRoot,
  isProjectLocalImportPath,
  isVirtualStaticCssEvalId,
  trimTrailingSlash
} from "./staticCssEval.js";

export const internalStaticCssEvalExternalResolutionPrefix =
  "external:mincho-static-css-eval:";

export type InternalStaticCssEvalSourceIdentity = StaticCssEvalSourceIdentity;

type SourceMetadata = Partial<
  Pick<
    StaticCssEvalSourceResolution,
    "sourceKind" | "sourceOrigin" | "unsupportedReason" | "watchFiles"
  >
>;

interface InternalStaticCssEvalDependency extends SourceMetadata {
  file: string;
  kind?: string;
  watchFiles?: readonly string[];
}

interface InternalStaticCssEvalResolvedDependency extends SourceMetadata {
  resolvedFile: string;
  canonicalModuleId?: string;
  normalizedPathKey?: string;
  watchFiles?: readonly string[];
}

interface InternalStaticCssEvalCacheKey extends SourceMetadata {
  importerFile?: string;
  resolvedFile?: string;
  resolvedId?: string;
  canonicalModuleId?: string;
  normalizedPathKey?: string;
  watchFiles?: readonly string[];
  parserVersion?: string | number;
}

type DiagnosticMetadata = Partial<
  Pick<
    NonNullable<BabelTransformResult["staticCssEval"]>["diagnostics"][number],
    "id"
  >
> & { dependency?: { file: string } };

export interface InternalStaticCssEvalMetadataLike {
  diagnostics?: readonly DiagnosticMetadata[];
  cacheKeys?: readonly InternalStaticCssEvalCacheKey[];
  dependencies?: readonly InternalStaticCssEvalDependency[];
  dependencyFiles?: readonly string[];
  resolvedDependencies?: readonly InternalStaticCssEvalResolvedDependency[];
  resolvedModuleIds?: readonly string[];
}

export function internalCollectStaticCssEvalDependencyIds(
  staticCssEval: InternalStaticCssEvalMetadataLike | undefined
): string[] {
  if (!staticCssEval) {
    return [];
  }

  return internalDedupeStaticCssEvalStrings([
    ...(staticCssEval.dependencyFiles ?? []),
    ...(staticCssEval.dependencies ?? [])
      .filter((dependency) => dependency.kind !== "local")
      .flatMap((dependency) => [dependency.file, ...getWatchFiles(dependency)]),
    ...(staticCssEval.resolvedDependencies ?? []).flatMap((dependency) => [
      dependency.resolvedFile,
      dependency.canonicalModuleId,
      dependency.normalizedPathKey,
      ...getWatchFiles(dependency)
    ]),
    ...(staticCssEval.cacheKeys ?? []).flatMap((cacheKey) => [
      cacheKey.resolvedFile,
      cacheKey.resolvedId,
      cacheKey.canonicalModuleId,
      cacheKey.normalizedPathKey,
      ...getWatchFiles(cacheKey)
    ]),
    ...(staticCssEval.resolvedModuleIds ?? [])
  ]);
}

function getWatchFiles(value: { watchFiles?: readonly string[] }): string[] {
  return [...(value.watchFiles ?? [])];
}

export function normalizeStaticCssEvalFileId(
  id: string,
  rootPath = ""
): string {
  const filePath = internalNormalizeStaticCssEvalPathSyntax(id);
  const normalizedRoot = rootPath
    ? internalNormalizeStaticCssEvalPathSyntax(rootPath)
    : "";

  if (
    normalizedRoot &&
    filePath.startsWith("/") &&
    !internalIsStaticCssEvalPathInsideRoot(normalizedRoot, filePath) &&
    !fs.existsSync(filePath)
  ) {
    return `${internalTrimStaticCssEvalTrailingSlash(normalizedRoot)}/${filePath.replace(/^\/+/, "")}`;
  }

  return filePath;
}

export function internalNormalizeStaticCssEvalPathSyntax(id: string): string {
  const strippedId = internalStripStaticCssEvalRequestQuery(
    internalStripStaticCssEvalSsrPrefix(id)
  );

  if (strippedId.startsWith("file://")) {
    try {
      return internalNormalizePathSyntax(fileURLToPath(strippedId));
    } catch {
      return internalNormalizePathSyntax(strippedId);
    }
  }

  const normalizedId = internalNormalizePathSyntax(strippedId);

  if (normalizedId.startsWith("/@fs/")) {
    return normalizedId.slice("/@fs".length);
  }

  return normalizedId;
}

export function internalIsProjectLocalStaticCssEvalImportPath(
  importPath: string
): boolean {
  return isProjectLocalImportPath(importPath);
}

export function internalIsVirtualStaticCssEvalId(id: string): boolean {
  return isVirtualStaticCssEvalId(id);
}

export function internalHasStaticCssEvalNodeModulesSegment(
  filePath: string
): boolean {
  return hasNodeModulesSegment(filePath, normalizeStaticCssEvalFileId);
}

export function internalIsStaticCssEvalPathInsideRoot(
  rootPath: string,
  filePath: string
): boolean {
  return isPathInsideRoot(
    rootPath,
    filePath,
    internalNormalizeStaticCssEvalPathSyntax
  );
}

export async function internalGetStaticCssEvalRealpathOrResolvedPath(
  filePath: string
): Promise<string> {
  return (
    (await internalGetExistingStaticCssEvalRealpath(filePath)) ??
    normalizeStaticCssEvalFileId(resolve(filePath))
  );
}

export async function internalGetExistingStaticCssEvalRealpath(
  filePath: string
): Promise<string | null> {
  return getExistingRealpath(filePath, normalizeStaticCssEvalFileId);
}

export async function internalGetExistingStaticCssEvalStat(
  filePath: string
): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
}

export function internalCreateStaticCssEvalSourceHash(stat: fs.Stats): string {
  return createStaticCssEvalSourceHash(stat);
}

export function internalCreateStaticCssEvalSourceIdentity(
  stat: fs.Stats
): Required<InternalStaticCssEvalSourceIdentity> {
  return {
    sourceHash: internalCreateStaticCssEvalSourceHash(stat),
    version: stat.mtimeMs
  };
}

export function internalIsMissingStaticCssEvalFileSystemEntryError(
  error: unknown
): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export function internalIsStaticCssEvalStaticDataFile(
  sourceId: string,
  realpath: string
): boolean {
  const flags = internalGetStaticCssEvalQueryFlags(sourceId);

  return (
    realpath.endsWith(".json") ||
    realpath.endsWith(".wasm") ||
    flags.some((flag) =>
      ["raw", "url", "text", "string", "init"].includes(flag)
    )
  );
}

export function internalPrepareStaticCssEvalStaticDataSource(
  sourceId: string,
  source: string
): string {
  const flags = internalGetStaticCssEvalQueryFlags(sourceId);

  return flags.includes("text") || flags.includes("string")
    ? `export default ${JSON.stringify(source)};\n`
    : source;
}

function internalStripStaticCssEvalSsrPrefix(id: string): string {
  let normalizedId = id;

  while (normalizedId.startsWith("ssr:")) {
    normalizedId = normalizedId.slice("ssr:".length);
  }

  return normalizedId;
}

export function internalStripStaticCssEvalRequestQuery(id: string): string {
  const queryIndex = id.search(/[?#]/);

  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}

function internalTrimStaticCssEvalTrailingSlash(filePath: string): string {
  return trimTrailingSlash(filePath);
}

function internalNormalizePathSyntax(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function internalDedupeStaticCssEvalStrings(
  values: readonly (string | undefined)[]
): string[] {
  return [...new Set(values.filter(internalIsStaticCssEvalStringValue))];
}

function internalIsStaticCssEvalStringValue(
  value: string | undefined
): value is string {
  return typeof value === "string" && value !== "";
}

export function internalGetStaticCssEvalQueryFlags(sourceId: string): string[] {
  const queryIndex = sourceId.indexOf("?");

  if (queryIndex === -1) {
    return [];
  }

  const hashIndex = sourceId.indexOf("#", queryIndex);
  const query = sourceId.slice(
    queryIndex + 1,
    hashIndex === -1 ? undefined : hashIndex
  );

  return query
    .split("&")
    .map((part) => part.split("=")[0])
    .filter(internalIsStaticCssEvalStringValue);
}
