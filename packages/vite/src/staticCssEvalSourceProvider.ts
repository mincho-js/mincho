import { parseSync } from "@babel/core";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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
  internalIsProjectLocalStaticCssEvalImportPath as isProjectLocalImportPath,
  internalIsStaticCssEvalPathInsideRoot as isPathInsideRoot,
  internalIsStaticCssEvalStaticDataFile as isStaticCssEvalStaticDataFile,
  internalIsVirtualStaticCssEvalId as isVirtualStaticCssEvalId,
  internalNormalizeStaticCssEvalFileId as normalizeStaticCssEvalFileId,
  internalPrepareStaticCssEvalStaticDataSource as prepareStaticCssEvalStaticDataSource
} from "@mincho-js/integration";
import { normalizePath } from "@rollup/pluginutils";
import * as fs from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  isFileLoadingAllowed,
  type DevEnvironment,
  type Plugin,
  type Rollup
} from "vite";
import { customNormalize } from "./cssState.js";
import { commonJsRuntimeId } from "./commonJs.js";

type PluginContext = Rollup.PluginContext;

export function createViteStaticCssEvalSourceProvider(
  pluginContext: PluginContext,
  ownerId: string,
  ownerSource: string | undefined,
  rootRealpath: string,
  devEnvironment?: DevEnvironment
): StaticCssEvalSourceProvider {
  return {
    async resolve(importerId, importPath, options) {
      // Vite's client output wraps virtual ids as browser URLs. Resolve the
      // original host id so the same plugin owns its load and watch records.
      const source = importPath.startsWith("/@id/")
        ? importPath.slice(5).replace("__x00__", "\0")
        : importPath;
      const resolveOptions = {
        // Analysis also follows modules emitted by this plugin. Include its
        // resolver just as the host does for the resulting runtime imports.
        skipSelf: false,

        // Analyze original sources without registering or reading optimizer output.
        ...(devEnvironment ? { scan: true } : {}),
        ...(options?.kind === "require"
          ? { custom: { "node-resolve": { isRequire: true } } }
          : {})
      };

      const resolved = devEnvironment?.pluginContainer.resolveId
        ? await devEnvironment.pluginContainer.resolveId(
            source,
            importerId,
            resolveOptions
          )
        : await pluginContext.resolve?.(source, importerId, resolveOptions);

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
                resolved.id,
                true
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
      // Local source outside the root still belongs to Vite's module graph.
      // A native require wrapper would keep it in Node's cache across HMR.
      const localSource =
        isProjectLocalImportPath(importPath) &&
        ![fileId, resolvedRealpath].some(
          (file) =>
            hasNodeModulesSegment(file) || /(^|[\\/])\.yarn[\\/]/.test(file)
        );

      return {
        id: metadata.resolvedFile,
        ...metadata,
        consumerRuntimeId: resolved.id,
        ...(options?.kind === "require" &&
        metadata.sourceKind === "package-source" &&
        !localSource
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

      if (fileId === ownerId && ownerSource !== undefined) {
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
        const virtualSource = await loadViteTransformedModuleSource(
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

export async function loadViteTransformedModuleSource(
  id: string,
  pluginContext: PluginContext,
  devEnvironment: DevEnvironment | undefined
): Promise<StaticCssEvalLoadedSource | null> {
  if (devEnvironment) {
    // transformRequest performs SSR export rewriting after plugin transforms.
    // Static evaluation needs ESM exports from the current environment instead.
    await devEnvironment.moduleGraph.ensureEntryFromUrl(id);

    const loaded = await devEnvironment.pluginContainer.load(id);
    let source = typeof loaded === "string" ? loaded : loaded?.code;
    // Vite loads ordinary files after plugin load hooks decline them. Keep
    // that input policy, then run the complete host transform pipeline.
    const file = id.split(/[?#]/, 1)[0]!;
    if (
      loaded == null &&
      isAbsolute(file) &&
      !file.includes("\0") &&
      isFileLoadingAllowed(devEnvironment.getTopLevelConfig(), file)
    ) {
      try {
        source = await fs.promises.readFile(file, "utf8");
        pluginContext.addWatchFile(file);
      } catch (error) {
        if (!isMissingFileSystemEntryError(error)) throw error;
      }
    }
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

// This is a pattern-realm effect contract for one audited artifact, not an
// execution, export, Math, or native-array-method authority.
const supportedDigest =
  "adc8d1d9bab80984e8f7136074af8ee8e6f63bcf8ee75d8950577e4bd73af23a";
const placeholders = new Set([
  "__BASE__",
  "__HMR_BASE__",
  "__HMR_CONFIG_NAME__",
  "__HMR_DIRECT_TARGET__",
  "__HMR_ENABLE_OVERLAY__",
  "__HMR_HOSTNAME__",
  "__HMR_PORT__",
  "__HMR_PROTOCOL__",
  "__HMR_TIMEOUT__",
  "__SERVER_HOST__",
  "__WS_TOKEN__"
]);
const ignoredKeys = new Set([
  "start",
  "end",
  "loc",
  "extra",
  "leadingComments",
  "innerComments",
  "trailingComments",
  "comments",
  "tokens",
  "errors"
]);
const hash = (source: string) =>
  createHash("sha256").update(source).digest("hex");
type JsonNode = { [key: string]: unknown };
function record(value: unknown): value is JsonNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function primitive(value: unknown): boolean {
  if (!record(value)) return false;
  if (
    [
      "StringLiteral",
      "NumericLiteral",
      "BooleanLiteral",
      "NullLiteral"
    ].includes(String(value.type))
  )
    return true;
  return (
    value.type === "UnaryExpression" &&
    value.operator === "-" &&
    record(value.argument) &&
    value.argument.type === "NumericLiteral"
  );
}
/** Compare syntax, not evaluated values. Every non-config node must survive. */
export function matchesViteClientSource(
  baseline: string,
  source: string,
  envSpecifier: string
): boolean {
  const parse = (text: string) =>
    parseSync(text, { babelrc: false, configFile: false, sourceType: "module" })
      ?.program;
  function same(expected: unknown, actual: unknown): boolean {
    if (Array.isArray(expected)) {
      const values = actual;
      return (
        Array.isArray(values) &&
        expected.length === values.length &&
        expected.every((item, i) => same(item, values[i]))
      );
    }
    if (!record(expected)) return expected === actual;
    if (!record(actual)) return false;
    let candidate = actual;
    if (
      expected.type === "Identifier" &&
      placeholders.has(String(expected.name))
    )
      return primitive(actual);
    if (
      expected.type === "ImportDeclaration" &&
      record(expected.source) &&
      expected.source.value === "@vite/env"
    ) {
      if (!record(actual.source) || actual.source.value !== envSpecifier)
        return false;
      candidate = {
        ...actual,
        source: { ...actual.source, value: "@vite/env" }
      };
    }
    const keys = Object.keys(expected).filter((key) => !ignoredKeys.has(key));
    const other = Object.keys(candidate).filter((key) => !ignoredKeys.has(key));
    return (
      keys.length === other.length &&
      keys.every(
        (key) =>
          Object.hasOwn(candidate, key) && same(expected[key], candidate[key])
      )
    );
  }
  try {
    const original = parse(baseline);
    return !!original && same(original, parse(source));
  } catch {
    return false;
  }
}

export function createViteClientIntrinsicObserver() {
  let client: string | undefined;
  let env: string | undefined;
  let generation = 0;
  let issued: { source: string; generation: number } | undefined;
  const issuer: Plugin = {
    name: "mincho-vite-client-effect-issuer",
    perEnvironmentWatchChangeDuringDev: true,
    buildStart() {
      generation++;
      issued = undefined;
    },
    watchChange() {
      generation++;
      issued = undefined;
    },
    load: {
      order: "post",
      handler(id) {
        if (
          this.environment.mode !== "dev" ||
          !isAbsolute(id) ||
          !id.endsWith("/dist/client/client.mjs")
        )
          return;
        // Insertion does not re-sort environment plugins. Match Vite's stable
        // hook ordering and decline if any later loader could have supplied it.
        const loaders = this.environment.plugins
          .filter((plugin) => plugin.load)
          .map((plugin, index) => ({
            plugin,
            index,
            order:
              typeof plugin.load === "object" ? plugin.load.order : undefined
          }));
        const rank = (order: unknown) =>
          order === "pre" ? -1 : order === "post" ? 1 : 0;
        loaders.sort(
          (a, b) => rank(a.order) - rank(b.order) || a.index - b.index
        );
        if (loaders.at(-1)?.plugin !== issuer) return;
        try {
          // Resolve the package from the actual physical host request, not
          // cwd or this plugin's (possibly different) peer installation.
          const require = createRequire(id);
          const root = dirname(require.resolve("vite/package.json"));
          if (id !== join(root, "dist/client/client.mjs")) return;
          const source = fs.readFileSync(id, "utf8");
          if (hash(source) !== supportedDigest) return;
          client = id;
          env = join(root, "dist/client/env.mjs");
          this.addWatchFile(id);
          issued = { source, generation };
          return source;
        } catch {
          return;
        }
      }
    }
  };
  return {
    issuer,
    async validate(
      id: string,
      source: string,
      resolve: (
        specifier: string,
        importer: string
      ) => Promise<string | undefined>
    ) {
      const receipt = issued;
      if (
        !client ||
        !env ||
        id !== client ||
        !receipt ||
        receipt.generation !== generation
      )
        return undefined;
      let specifier: string | undefined;
      try {
        const ast = parseSync(source, {
          babelrc: false,
          configFile: false,
          sourceType: "module"
        });
        const imports = ast?.program.body.filter(
          (node) => node.type === "ImportDeclaration"
        );
        if (imports?.length !== 1) return undefined;
        specifier = imports[0]!.source.value;
      } catch {
        return undefined;
      }
      if (
        (await resolve(specifier, id)) !== env ||
        !matchesViteClientSource(receipt.source, source, specifier)
      )
        return undefined;
      const current = () => {
        try {
          return (
            issued === receipt &&
            generation === receipt.generation &&
            hash(fs.readFileSync(client!, "utf8")) === supportedDigest
          );
        } catch {
          return false;
        }
      };
      if (!current()) return undefined;
      return {
        key: `vite-client-pattern-v1:${supportedDigest}:${generation}:${hash(source)}`,
        validate: (candidate: string) => candidate === source && current()
      };
    }
  };
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore import.meta is removed from the CommonJS build.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore import.meta is removed from the CommonJS build.
  const { expect, it } = import.meta.vitest;

  it("retains the actual host query ID independently of raw source identity", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await fs.promises.mkdtemp(
      join(tmpdir(), "mincho-runtime-id-")
    );
    const file = join(root, "theme.css.ts");
    const owner = join(root, "app.ts");

    try {
      await fs.promises.writeFile(file, 'export const theme = "authoring";');
      const provider = createViteStaticCssEvalSourceProvider(
        {
          resolve: async (source: string) => ({
            id: `${file}${source.slice(source.indexOf("?"))}`
          })
        } as unknown as PluginContext,
        owner,
        "",
        root
      );
      const dark = await provider.resolve(owner, "./theme.css.ts?theme=dark");
      const light = await provider.resolve(
        owner,
        "./theme.css.ts?theme=light",
        { kind: "require" }
      );

      expect(dark).toMatchObject({
        consumerRuntimeId: `${file}?theme=dark`,
        realpath: file,
        canonicalModuleId: file,
        normalizedPathKey: file
      });
      expect(light?.consumerRuntimeId).toBe(`${file}?theme=light`);
      expect((await provider.load(dark!.normalizedPathKey!))?.sourceText).toBe(
        'export const theme = "authoring";'
      );
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
}
