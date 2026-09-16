import {
  type InternalStaticCssEvalLoadedSource as StaticCssEvalLoadedSource,
  type InternalStaticCssEvalSourceIdentity as StaticCssEvalSourceIdentity,
  type InternalStaticCssEvalSourceKind as StaticCssEvalSourceKind,
  type InternalStaticCssEvalSourceProvider as StaticCssEvalSourceProvider,
  type InternalStaticCssEvalSourceResolution as StaticCssEvalSourceResolution,
  internalCreateStaticCssEvalSourceHash as createStaticCssEvalSourceHash,
  internalCreateStaticCssEvalSourceIdentity as createStaticCssEvalSourceIdentity,
  internalResolveFromModule as resolveFromModule,
  internalStaticCssEvalExternalResolutionPrefix as externalStaticCssEvalResolutionPrefix,
  internalGetExistingStaticCssEvalRealpath as getExistingRealpath,
  internalGetExistingStaticCssEvalStat as getExistingStat,
  internalGetStaticCssEvalQueryFlags as getViteStaticCssEvalQueryFlags,
  internalGetStaticCssEvalSourceOrigin as getViteStaticCssEvalSourceOrigin,
  internalHasStaticCssEvalNodeModulesSegment as hasNodeModulesSegment,
  internalIsMissingStaticCssEvalFileSystemEntryError as isMissingFileSystemEntryError,
  internalIsStaticCssEvalPathInsideRoot as isPathInsideRoot,
  internalIsStaticCssEvalStaticDataFile as isStaticCssEvalStaticDataFile,
  internalIsVirtualStaticCssEvalId as isVirtualStaticCssEvalId,
  internalNormalizeStaticCssEvalFileId as normalizeStaticCssEvalFileId,
  internalPrepareStaticCssEvalStaticDataSource as prepareStaticCssEvalStaticDataSource
} from "@mincho-js/integration";
import { normalizePath } from "@rollup/pluginutils";
import * as fs from "node:fs";
import type { DevEnvironment, Rollup } from "vite";
import { customNormalize } from "./cssState.js";
import { commonJsRuntimeId } from "./commonJs.js";

type PluginContext = Rollup.PluginContext;

export function createViteStaticCssEvalSourceProvider(
  pluginContext: PluginContext,
  ownerId: string,
  ownerSource: string,
  rootRealpath: string,
  devEnvironment?: DevEnvironment
): StaticCssEvalSourceProvider {
  return {
    async resolve(importerId, importPath, options) {
      const resolveOptions = {
        skipSelf: true,

        // Analyze original sources without registering or reading optimizer output.
        ...(devEnvironment ? { scan: true } : {}),
        ...(options?.kind === "require"
          ? { custom: { "node-resolve": { isRequire: true } } }
          : {})
      };

      const resolved = devEnvironment?.pluginContainer.resolveId
        ? await devEnvironment.pluginContainer.resolveId(
            importPath,
            importerId,
            resolveOptions
          )
        : await pluginContext.resolve?.(importPath, importerId, resolveOptions);

      if (!resolved) {
        return null;
      }

      if (resolved.external) {
        const resolution = createExternalStaticCssEvalResolution(resolved.id);

        if (options?.kind === "require" && !resolved.id.startsWith("node:")) {
          try {
            const file = resolveFromModule(importerId, resolved.id);

            if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file))
              resolution.commonJsRuntimeId = commonJsRuntimeId(
                file,
                importPath
              );
          } catch {
            // Preserve external resolver ownership when Node cannot resolve its id.
          }
        }

        return resolution;
      }

      if (isVirtualStaticCssEvalId(resolved.id)) {
        return canLoadViteStaticCssEvalVirtualSource(
          pluginContext,
          devEnvironment
        )
          ? createViteStaticCssEvalVirtualResolution(resolved.id)
          : createUnsupportedStaticCssEvalResolution(importPath);
      }

      const fileId = normalizeStaticCssEvalFileId(resolved.id, rootRealpath);
      const resolvedRealpath = await getExistingRealpath(fileId);

      if (!resolvedRealpath) {
        return null;
      }

      let stat: fs.Stats;

      try {
        stat = await fs.promises.stat(resolvedRealpath);
      } catch (error) {
        if (isMissingFileSystemEntryError(error)) {
          return null;
        }

        throw error;
      }

      const metadata = createViteStaticCssEvalFileMetadata({
        id: resolved.id,
        realpath: resolvedRealpath,
        rootRealpath,
        stat
      });

      return {
        id: metadata.resolvedFile,
        ...metadata,
        ...(options?.kind === "require" &&
        metadata.sourceKind === "package-source"
          ? {
              commonJsRuntimeId: commonJsRuntimeId(
                metadata.resolvedFile,
                importPath
              )
            }
          : {})
      };
    },

    async load(id: string) {
      const fileId = normalizeStaticCssEvalFileId(id, rootRealpath);

      if (fileId === ownerId) {
        const ownerRealpath = await getExistingRealpath(fileId);
        const stat = ownerRealpath
          ? await getExistingStat(ownerRealpath)
          : null;

        const sourceIdentity = stat
          ? createStaticCssEvalSourceIdentity(stat)
          : undefined;

        return {
          sourceText: ownerSource,
          source: ownerSource,
          resolvedFile: ownerRealpath ?? ownerId,
          canonicalModuleId: ownerId,
          normalizedPathKey: ownerId,
          ...(ownerRealpath ? { realpath: ownerRealpath } : {}),
          ...(sourceIdentity ? { sourceIdentity } : {}),
          sourceKind: "project-source",
          sourceOrigin: "project",
          ...(ownerRealpath ? { watchFiles: [ownerRealpath] } : {}),
          resolverKind: "vite"
        };
      }

      if (isUnsupportedStaticCssEvalResolutionId(id)) {
        return {
          sourceText: "export {};",
          source: "export {};",
          sourceKind: "unsupported-source-shape",
          sourceOrigin: "unsupported",
          unsupportedReason: "unsupported-source-shape",
          resolverKind: "vite"
        };
      }

      if (isExternalStaticCssEvalResolutionId(id)) {
        return null;
      }

      if (isVirtualStaticCssEvalId(id)) {
        const virtualSource = await loadViteStaticCssEvalVirtualSource(
          id,
          pluginContext,
          devEnvironment
        );

        return virtualSource
          ? {
              ...virtualSource,
              resolvedFile: id,
              canonicalModuleId: id,
              normalizedPathKey: id,
              sourceKind: "provider-virtual",
              sourceOrigin: "provider",
              resolverKind: "vite"
            }
          : null;
      }

      const realpath = await getExistingRealpath(fileId);
      if (!realpath) {
        return null;
      }

      let fileSource: string;
      let stat: fs.Stats;

      try {
        [fileSource, stat] = await Promise.all([
          fs.promises.readFile(realpath, "utf8"),
          fs.promises.stat(realpath)
        ]);
      } catch (error) {
        if (isMissingFileSystemEntryError(error)) {
          return null;
        }

        throw error;
      }

      const metadata = createViteStaticCssEvalFileMetadata({
        id,
        realpath,
        rootRealpath,
        stat
      });

      const source = getViteStaticCssEvalStaticDataSource({
        id,
        realpath,
        rootRealpath,
        source: fileSource
      });

      return {
        sourceText: source,
        source,
        ...metadata
      };
    }
  };
}

interface ViteStaticCssEvalFileMetadataOptions {
  id: string;
  realpath: string;
  rootRealpath: string;
  stat: fs.Stats;
}

function createViteStaticCssEvalFileMetadata({
  id,
  realpath,
  rootRealpath,
  stat
}: ViteStaticCssEvalFileMetadataOptions): Required<
  Pick<
    StaticCssEvalSourceResolution,
    | "canonicalModuleId"
    | "normalizedPathKey"
    | "realpath"
    | "resolvedFile"
    | "resolverKind"
    | "sourceHash"
    | "sourceIdentity"
    | "sourceKind"
    | "sourceOrigin"
    | "version"
    | "watchFiles"
  >
> {
  const sourceHash = createStaticCssEvalSourceHash(stat);
  const version = stat.mtimeMs;
  const sourceIdentity: Required<
    Pick<StaticCssEvalSourceIdentity, "sourceHash" | "version">
  > = {
    sourceHash,
    version
  };

  const sourceKind = getViteStaticCssEvalFileSourceKind({
    id,
    realpath,
    rootRealpath
  });

  const querySuffix =
    sourceKind === "static-data" ? getViteStaticCssEvalQuerySuffix(id) : "";

  const resolvedFile = `${realpath}${querySuffix}`;

  return {
    resolvedFile,
    canonicalModuleId: resolvedFile,
    normalizedPathKey: resolvedFile,
    realpath,
    sourceHash: sourceIdentity.sourceHash,
    version: sourceIdentity.version,
    sourceIdentity,
    sourceKind,
    sourceOrigin: getViteStaticCssEvalSourceOrigin(sourceKind),
    watchFiles: [realpath],
    resolverKind: "vite"
  };
}

function getViteStaticCssEvalFileSourceKind({
  id,
  realpath,
  rootRealpath
}: Pick<
  ViteStaticCssEvalFileMetadataOptions,
  "id" | "realpath" | "rootRealpath"
>): StaticCssEvalSourceKind {
  if (isStaticCssEvalStaticDataFile(id, realpath)) {
    return "static-data";
  }

  return hasNodeModulesSegment(realpath) ||
    !isPathInsideRoot(rootRealpath, realpath)
    ? "package-source"
    : "project-source";
}

function getViteStaticCssEvalQuerySuffix(id: string): string {
  const queryStart = id.indexOf("?");

  if (queryStart === -1) {
    return "";
  }

  const hashStart = id.indexOf("#", queryStart);

  return id.slice(queryStart, hashStart === -1 ? undefined : hashStart);
}

function getViteStaticCssEvalStaticDataSource(options: {
  id: string;
  realpath: string;
  rootRealpath: string;
  source: string;
}): string {
  const flags = getViteStaticCssEvalQueryFlags(options.id);

  if (flags.includes("url")) {
    const assetUrl = getViteStaticCssEvalUrlSource(
      options.realpath,
      options.rootRealpath
    );

    return `export default ${JSON.stringify(assetUrl)};\n`;
  }

  return prepareStaticCssEvalStaticDataSource(options.id, options.source);
}

function getViteStaticCssEvalUrlSource(
  realpath: string,
  rootRealpath: string
): string {
  const normalizedRealpath = normalizePath(realpath);
  const normalizedRootRealpath = normalizePath(rootRealpath);

  if (isPathInsideRoot(normalizedRootRealpath, normalizedRealpath)) {
    return `/${customNormalize(normalizedRealpath.slice(normalizedRootRealpath.length))}`;
  }

  return `/@fs/${customNormalize(normalizedRealpath)}`;
}

function createViteStaticCssEvalVirtualResolution(
  id: string
): StaticCssEvalSourceResolution {
  return {
    id,
    resolvedFile: id,
    canonicalModuleId: id,
    normalizedPathKey: id,
    sourceKind: "provider-virtual",
    sourceOrigin: "provider",
    resolverKind: "vite"
  };
}

function canLoadViteStaticCssEvalVirtualSource(
  pluginContext: PluginContext,
  devEnvironment: DevEnvironment | undefined
): boolean {
  return Boolean(devEnvironment?.pluginContainer || pluginContext.load);
}

async function loadViteStaticCssEvalVirtualSource(
  id: string,
  pluginContext: PluginContext,
  devEnvironment: DevEnvironment | undefined
): Promise<StaticCssEvalLoadedSource | null> {
  if (devEnvironment) {
    // transformRequest performs SSR export rewriting after plugin transforms.
    // Static evaluation needs ESM exports from the current environment instead.
    await devEnvironment.moduleGraph.ensureEntryFromUrl(id);

    const loaded = await devEnvironment.pluginContainer.load(id);
    const source = typeof loaded === "string" ? loaded : loaded?.code;
    if (typeof source !== "string") return null;

    const transformed = await devEnvironment.pluginContainer.transform(
      source,
      id
    );

    const sourceText = transformed?.code ?? source;
    const module = devEnvironment.moduleGraph.getModuleById(id);
    const pendingModules = module ? [module] : [];
    const seenModules = new Set(pendingModules);
    const watchFiles = new Set<string>();

    while (pendingModules.length > 0) {
      const current = pendingModules.pop()!;

      if (current.file) watchFiles.add(current.file);

      for (const dependency of current.importedModules) {
        if (!seenModules.has(dependency)) {
          seenModules.add(dependency);
          pendingModules.push(dependency);
        }
      }
    }

    return { sourceText, source: sourceText, watchFiles: [...watchFiles] };
  }

  const loaded = await pluginContext.load?.({ id });

  return typeof loaded?.code === "string"
    ? { sourceText: loaded.code, source: loaded.code }
    : null;
}

function createExternalStaticCssEvalResolution(
  id: string
): StaticCssEvalSourceResolution {
  const resolvedId = `${externalStaticCssEvalResolutionPrefix}${encodeURIComponent(
    id
  )}`;

  return {
    id: resolvedId,
    resolvedFile: resolvedId,
    canonicalModuleId: id,
    normalizedPathKey: resolvedId,
    sourceKind: "external-no-source",
    sourceOrigin: "external",
    unsupportedReason: "external-no-source",
    resolverKind: "vite"
  };
}

function createUnsupportedStaticCssEvalResolution(
  importPath: string
): StaticCssEvalSourceResolution {
  const id = `virtual:mincho-static-css-eval-unsupported:${encodeURIComponent(
    importPath
  )}`;

  return {
    id,
    resolvedFile: id,
    canonicalModuleId: id,
    normalizedPathKey: id,
    sourceKind: "unsupported-source-shape",
    sourceOrigin: "unsupported",
    unsupportedReason: "unsupported-source-shape",
    resolverKind: "vite"
  };
}

function isUnsupportedStaticCssEvalResolutionId(id: string): boolean {
  return id.startsWith("virtual:mincho-static-css-eval-unsupported:");
}

function isExternalStaticCssEvalResolutionId(id: string): boolean {
  return id.startsWith(externalStaticCssEvalResolutionPrefix);
}
