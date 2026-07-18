import * as fs from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface InternalStaticCssEvalSourceIdentity {
  sourceHash?: string;
  version?: string | number;
}

interface InternalStaticCssEvalDependency {
  file: string;
  kind?: string;
}

interface InternalStaticCssEvalResolvedDependency {
  resolvedFile: string;
  canonicalModuleId?: string;
  normalizedPathKey?: string;
}

interface InternalStaticCssEvalCacheKey {
  resolvedFile?: string;
  resolvedId?: string;
}

export interface InternalStaticCssEvalMetadataLike {
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
      .map((dependency) => dependency.file),
    ...(staticCssEval.resolvedDependencies ?? []).flatMap((dependency) => [
      dependency.resolvedFile,
      dependency.canonicalModuleId,
      dependency.normalizedPathKey
    ]),
    ...(staticCssEval.cacheKeys ?? []).flatMap((cacheKey) => [
      cacheKey.resolvedFile,
      cacheKey.resolvedId
    ]),
    ...(staticCssEval.resolvedModuleIds ?? [])
  ]);
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
  return importPath.startsWith(".") || importPath.startsWith("/");
}

export function internalIsVirtualStaticCssEvalId(id: string): boolean {
  return (
    id.startsWith("\0") ||
    id.includes("\0") ||
    id.startsWith("virtual:") ||
    id.includes("__x00__")
  );
}

export function internalHasStaticCssEvalNodeModulesSegment(
  filePath: string
): boolean {
  return normalizeStaticCssEvalFileId(filePath)
    .split("/")
    .includes("node_modules");
}

export function internalIsStaticCssEvalPathInsideRoot(
  rootPath: string,
  filePath: string
): boolean {
  const normalizedRoot = internalTrimStaticCssEvalTrailingSlash(
    internalNormalizeStaticCssEvalPathSyntax(rootPath)
  );
  const normalizedFilePath = internalTrimStaticCssEvalTrailingSlash(
    internalNormalizeStaticCssEvalPathSyntax(filePath)
  );

  return (
    normalizedFilePath === normalizedRoot ||
    normalizedFilePath.startsWith(`${normalizedRoot}/`)
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
  try {
    return normalizeStaticCssEvalFileId(await fs.promises.realpath(filePath));
  } catch {
    return null;
  }
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
  return `mtime:${stat.mtimeMs}:size:${stat.size}`;
}

export function internalCreateStaticCssEvalSourceIdentity(
  stat: fs.Stats
): InternalStaticCssEvalSourceIdentity {
  return {
    sourceHash: internalCreateStaticCssEvalSourceHash(stat),
    version: stat.mtimeMs
  };
}

function internalStripStaticCssEvalSsrPrefix(id: string): string {
  let normalizedId = id;

  while (normalizedId.startsWith("ssr:")) {
    normalizedId = normalizedId.slice("ssr:".length);
  }

  return normalizedId;
}

function internalStripStaticCssEvalRequestQuery(id: string): string {
  const queryIndex = id.search(/[?#]/);
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}

function internalTrimStaticCssEvalTrailingSlash(filePath: string): string {
  return filePath.length > 1 ? filePath.replace(/\/+$/g, "") : filePath;
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
