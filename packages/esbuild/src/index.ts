import * as fs from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { vanillaExtractPlugin } from "@vanilla-extract/esbuild-plugin";
import {
  type Plugin as EsbuildPlugin,
  type PluginBuild,
  type ResolveResult
} from "esbuild";
import {
  type BabelOptions,
  babelTransform,
  compile,
  createStaticCssEvalSourceHash as createSharedStaticCssEvalSourceHash,
  createUnsupportedStaticCssEvalResolution as createSharedUnsupportedStaticCssEvalResolution,
  getExistingRealpath as getSharedExistingRealpath,
  getRealpathOrResolvedPath as getSharedRealpathOrResolvedPath,
  hasNodeModulesSegment as sharedHasNodeModulesSegment,
  isPathInsideRoot as sharedIsPathInsideRoot,
  isProjectLocalImportPath as sharedIsProjectLocalImportPath,
  isUnsupportedStaticCssEvalResolutionId as sharedIsUnsupportedStaticCssEvalResolutionId,
  isVirtualStaticCssEvalId as sharedIsVirtualStaticCssEvalId,
  processDefineRulesPresetRegistryFile,
  runDefineRulesPresetRegistryStep
} from "@mincho-js/integration";

type ScriptLoader = "js" | "jsx" | "ts" | "tsx";

type MaybePromise<T> = T | Promise<T>;

interface StaticCssEvalSourceResolution {
  id: string;
  realpath?: string;
  sourceHash?: string;
  version?: string | number;
}

interface StaticCssEvalLoadedSource {
  source: string;
  realpath?: string;
  sourceHash?: string;
  version?: string | number;
}

interface StaticCssEvalSourceProvider {
  resolve(
    importerId: string,
    importPath: string
  ): MaybePromise<StaticCssEvalSourceResolution | null>;
  load(id: string): MaybePromise<StaticCssEvalLoadedSource | null>;
}

const integrationHelpers = {
  babelTransform,
  compile,
  processDefineRulesPresetRegistryFile,
  runDefineRulesPresetRegistryStep
};

type MinchoBabelOptions = BabelOptions & { jsxCssProp?: boolean };

type MinchoBabelOptionsWithStaticCssEval = MinchoBabelOptions & {
  staticCssEvalSourceProvider?: StaticCssEvalSourceProvider;
};

type BabelTransformResult = Awaited<ReturnType<typeof babelTransform>> & {
  staticCssEval?: {
    dependencyFiles: string[];
  };
};

type StaticCssEvalResolutionCache = Map<
  string,
  StaticCssEvalSourceResolution | null
>;

type StaticCssEvalLoadedSourceCache = Map<
  string,
  StaticCssEvalLoadedSource | null
>;

function getScriptLoader(path: string): ScriptLoader {
  if (/\.tsx$/i.test(path)) return "tsx";
  if (/\.ts$/i.test(path)) return "ts";
  if (/\.jsx$/i.test(path)) return "jsx";
  return "js";
}

function createEsbuildStaticCssEvalSourceProvider(options: {
  build: PluginBuild;
  ownerId: string;
  ownerSource: string;
  rootRealpath: Promise<string>;
  resolutionCache: StaticCssEvalResolutionCache;
  loadedSourceCache: StaticCssEvalLoadedSourceCache;
}): StaticCssEvalSourceProvider {
  const ownerId = normalizeStaticCssEvalFileId(options.ownerId);

  return {
    async resolve(importerId: string, importPath: string) {
      const cacheKey = `${normalizeStaticCssEvalFileId(importerId)}\0${importPath}`;

      if (options.resolutionCache.has(cacheKey)) {
        return options.resolutionCache.get(cacheKey) ?? null;
      }

      const resolution = await resolveEsbuildStaticCssEvalImport({
        build: options.build,
        importerId,
        importPath,
        rootRealpath: options.rootRealpath
      });

      options.resolutionCache.set(cacheKey, resolution);
      return resolution;
    },
    async load(id: string) {
      const cacheKey = normalizeStaticCssEvalFileId(id);

      if (options.loadedSourceCache.has(cacheKey)) {
        return options.loadedSourceCache.get(cacheKey) ?? null;
      }

      const loadedSource = await loadEsbuildStaticCssEvalSource({
        id,
        ownerId,
        ownerSource: options.ownerSource,
        rootRealpath: options.rootRealpath
      });

      options.loadedSourceCache.set(cacheKey, loadedSource);
      return loadedSource;
    }
  };
}

async function resolveEsbuildStaticCssEvalImport(options: {
  build: PluginBuild;
  importerId: string;
  importPath: string;
  rootRealpath: Promise<string>;
}): Promise<StaticCssEvalSourceResolution | null> {
  if (!isProjectLocalImportPath(options.importPath)) {
    return createUnsupportedStaticCssEvalResolution(options.importPath);
  }

  const resolved = await resolveEsbuildImport(
    options.build,
    options.importerId,
    options.importPath
  );

  if (resolved == null) {
    return null;
  }

  if (
    resolved.external ||
    (resolved.namespace !== "" && resolved.namespace !== "file") ||
    isVirtualStaticCssEvalId(resolved.path)
  ) {
    return createUnsupportedStaticCssEvalResolution(options.importPath);
  }

  const resolvedId = normalizeStaticCssEvalFileId(resolved.path);
  const resolvedRealpath = await getExistingRealpath(resolvedId);

  if (!resolvedRealpath) {
    return null;
  }

  const rootRealpath = await options.rootRealpath;

  if (
    hasNodeModulesSegment(resolvedRealpath) ||
    !isPathInsideRoot(rootRealpath, resolvedRealpath)
  ) {
    return createUnsupportedStaticCssEvalResolution(options.importPath);
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

  return {
    id: resolvedRealpath,
    realpath: resolvedRealpath,
    sourceHash: createStaticCssEvalSourceHash(stat),
    version: stat.mtimeMs
  };
}

async function resolveEsbuildImport(
  build: PluginBuild,
  importerId: string,
  importPath: string
): Promise<ResolveResult | null> {
  if (typeof build.resolve === "function") {
    const resolved = await build.resolve(importPath, {
      importer: importerId,
      kind: "import-statement",
      resolveDir: dirname(importerId)
    });

    if (resolved.errors.length > 0 || resolved.path === "") {
      return null;
    }

    return resolved;
  }

  const resolvedPath = resolveStaticCssEvalImportFromFileSystem(
    importerId,
    importPath
  );

  return resolvedPath ? createStaticCssEvalResolveResult(resolvedPath) : null;
}

async function loadEsbuildStaticCssEvalSource(options: {
  id: string;
  ownerId: string;
  ownerSource: string;
  rootRealpath: Promise<string>;
}): Promise<StaticCssEvalLoadedSource | null> {
  const fileId = normalizeStaticCssEvalFileId(options.id);

  if (fileId === options.ownerId) {
    const ownerRealpath = await getExistingRealpath(fileId);

    return {
      source: options.ownerSource,
      ...(ownerRealpath ? { realpath: ownerRealpath } : {})
    };
  }

  if (isUnsupportedStaticCssEvalResolutionId(options.id)) {
    return { source: "export {};" };
  }

  if (isVirtualStaticCssEvalId(options.id) || hasNodeModulesSegment(fileId)) {
    return null;
  }

  const realpath = await getExistingRealpath(fileId);
  const rootRealpath = await options.rootRealpath;

  if (
    !realpath ||
    hasNodeModulesSegment(realpath) ||
    !isPathInsideRoot(rootRealpath, realpath)
  ) {
    return null;
  }

  let source: string;
  let stat: fs.Stats;

  try {
    [source, stat] = await Promise.all([
      fs.promises.readFile(realpath, "utf8"),
      fs.promises.stat(realpath)
    ]);
  } catch (error) {
    if (isMissingFileSystemEntryError(error)) {
      return null;
    }

    throw error;
  }

  return {
    source,
    realpath,
    sourceHash: createStaticCssEvalSourceHash(stat),
    version: stat.mtimeMs
  };
}

function createUnsupportedStaticCssEvalResolution(
  importPath: string
): StaticCssEvalSourceResolution {
  return createSharedUnsupportedStaticCssEvalResolution(importPath);
}

function isUnsupportedStaticCssEvalResolutionId(id: string): boolean {
  return sharedIsUnsupportedStaticCssEvalResolutionId(id);
}

function normalizeStaticCssEvalFileId(id: string): string {
  return stripStaticCssEvalRequestQuery(id).replace(/\\/g, "/");
}

function stripStaticCssEvalRequestQuery(id: string): string {
  const queryIndex = id.search(/[?#]/);
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}

function isProjectLocalImportPath(importPath: string): boolean {
  return sharedIsProjectLocalImportPath(importPath);
}

function isVirtualStaticCssEvalId(id: string): boolean {
  return sharedIsVirtualStaticCssEvalId(id);
}

function hasNodeModulesSegment(filePath: string): boolean {
  return sharedHasNodeModulesSegment(filePath, normalizeStaticCssEvalFileId);
}

function isPathInsideRoot(rootPath: string, filePath: string): boolean {
  return sharedIsPathInsideRoot(
    rootPath,
    filePath,
    normalizeStaticCssEvalFileId
  );
}

async function getRealpathOrResolvedPath(filePath: string): Promise<string> {
  return getSharedRealpathOrResolvedPath(filePath, {
    normalizeFilePath: normalizeStaticCssEvalFileId,
    resolvePath
  });
}

async function getExistingRealpath(filePath: string): Promise<string | null> {
  return getSharedExistingRealpath(filePath, normalizeStaticCssEvalFileId);
}

function createStaticCssEvalSourceHash(stat: fs.Stats): string {
  return createSharedStaticCssEvalSourceHash(stat);
}

function isMissingFileSystemEntryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function getWatchableStaticCssEvalDependencyFiles(
  rootRealpath: string,
  dependencyFiles: readonly string[] | undefined
): string[] {
  const watchFiles = new Set<string>();

  for (const dependencyFile of dependencyFiles ?? []) {
    const fileId = normalizeStaticCssEvalFileId(dependencyFile);

    if (
      isVirtualStaticCssEvalId(fileId) ||
      hasNodeModulesSegment(fileId) ||
      !isPathInsideRoot(rootRealpath, fileId)
    ) {
      continue;
    }

    watchFiles.add(fileId);
  }

  return [...watchFiles];
}

function resolveStaticCssEvalImportFromFileSystem(
  importerId: string,
  importPath: string
): string | null {
  if (
    !isProjectLocalImportPath(importPath) ||
    isVirtualStaticCssEvalId(importPath)
  ) {
    return null;
  }

  const basePath = importPath.startsWith("/")
    ? importPath
    : resolvePath(dirname(importerId), importPath);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    join(basePath, "index.ts"),
    join(basePath, "index.tsx"),
    join(basePath, "index.js"),
    join(basePath, "index.jsx")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function createStaticCssEvalResolveResult(path: string): ResolveResult {
  return {
    errors: [],
    warnings: [],
    path,
    external: false,
    sideEffects: true,
    namespace: "file",
    suffix: "",
    pluginData: undefined
  };
}

interface MinchoEsbuildPluginOptions {
  includeNodeModulesPattern?: RegExp;
  jsxCssProp?: boolean;
}

/**
 * Plugin flow:
 * 1. Intercepts TypeScript/JavaScript files (*.tsx, *.jsx, *.ts, *.js)
 * 2. Extracts CSS using Babel and injects imports to generated CSS files (extracted_[hash].css.ts)
 * 3. Processes extracted CSS:
 *    - Resolves all imports in the CSS files
 *    - Bundles the code with proper file scoping
 *    - Generates vanilla-extract compatible .css.ts files
 *    - Hands off to @vanilla-extract/esbuild-plugin for final CSS processing
 * 4. Returns the transformed JavaScript with proper CSS imports
 *
 * This plugin integrates Mincho.js styling with ESBuild's build process,
 * enabling zero-runtime CSS-in-JS with type safety.
 */
export function minchoEsbuildPlugin({
  includeNodeModulesPattern,
  jsxCssProp
}: MinchoEsbuildPluginOptions = {}): EsbuildPlugin {
  return {
    name: "mincho-js-esbuild",
    setup(build) {
      const resolvers = new Map<string, string>();
      const resolverCache = new Map<string, string>();
      const staticCssEvalResolutionCache: StaticCssEvalResolutionCache =
        new Map();
      const staticCssEvalLoadedSourceCache: StaticCssEvalLoadedSourceCache =
        new Map();
      const rootRealpath = getRealpathOrResolvedPath(
        build.initialOptions.absWorkingDir ?? process.cwd()
      );

      build.onEnd(() => {
        resolvers.clear();
        resolverCache.clear();
        staticCssEvalResolutionCache.clear();
        staticCssEvalLoadedSourceCache.clear();
      });

      build.onResolve({ filter: /^extracted_(.*)\.css\.ts$/ }, async (args) => {
        if (!resolvers.has(args.path)) {
          return;
        }

        const resolvedPath = join(args.importer, "..", args.path);

        return {
          namespace: "extracted-css",
          path: resolvedPath,
          pluginData: {
            path: args.path,
            mainFilePath: args.pluginData?.mainFilePath
          }
        };
      });

      build.onLoad(
        { filter: /.*/, namespace: "extracted-css" },
        async ({ path, pluginData }) => {
          const resolverContents = resolvers.get(pluginData.path)!;
          const { source } = await integrationHelpers.compile({
            esbuild: build.esbuild,
            filePath: path,
            originalPath: pluginData.mainFilePath!,
            contents: resolverContents,
            externals: [],
            cwd: build.initialOptions.absWorkingDir,
            resolverCache
          });

          try {
            const { source: contents } =
              await integrationHelpers.runDefineRulesPresetRegistryStep(() =>
                integrationHelpers.processDefineRulesPresetRegistryFile({
                  source,
                  filePath: path,
                  outputCss: undefined,
                  identOption: build.initialOptions.minify ? "short" : "debug"
                })
              );

            return {
              contents,
              loader: "js",
              resolveDir: dirname(path)
            };
          } catch (error) {
            if (error instanceof ReferenceError) {
              return {
                errors: [
                  {
                    text: error.toString(),
                    detail:
                      "This usually happens if you use a browser api at the top level of a file being imported."
                  }
                ]
              };
            }

            throw error;
          }
        }
      );

      build.onLoad({ filter: /\.(j|t)sx?$/ }, async (args) => {
        if (args.path.includes("node_modules")) {
          if (!includeNodeModulesPattern) return;
          if (!includeNodeModulesPattern.test(args.path)) return;
        }

        // gets handled by vanilla-extract/esbuild-plugin
        if (args.path.endsWith(".css.ts")) return;

        const babelOptions: MinchoBabelOptions | undefined =
          jsxCssProp === undefined ? undefined : { jsxCssProp };
        const transformBabelOptions:
          | MinchoBabelOptionsWithStaticCssEval
          | undefined =
          babelOptions?.jsxCssProp === true
            ? {
                ...babelOptions,
                staticCssEvalSourceProvider:
                  createEsbuildStaticCssEvalSourceProvider({
                    build,
                    ownerId: args.path,
                    ownerSource: await fs.promises.readFile(args.path, "utf8"),
                    rootRealpath,
                    resolutionCache: staticCssEvalResolutionCache,
                    loadedSourceCache: staticCssEvalLoadedSourceCache
                  })
              }
            : babelOptions;
        const {
          code,
          result: [file, cssExtract],
          staticCssEval
        } = (await integrationHelpers.babelTransform(
          args.path,
          transformBabelOptions
        )) as BabelTransformResult;

        // the extracted code and original are the same -> no css extracted
        if (file && cssExtract && cssExtract != code) {
          resolvers.set(file, cssExtract);
          resolverCache.delete(args.path);
        }

        return {
          contents: code,
          loader: getScriptLoader(args.path),
          pluginData: {
            mainFilePath: args.path
          },
          watchFiles: getWatchableStaticCssEvalDependencyFiles(
            await rootRealpath,
            staticCssEval?.dependencyFiles
          )
        };
      });
    }
  };
}

export const minchoEsbuildPlugins = (
  options: MinchoEsbuildPluginOptions = {}
) => [minchoEsbuildPlugin(options), vanillaExtractPlugin()];

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { afterEach, beforeAll, describe, expect, it, vi } = import.meta.vitest;

  const DEFINE_RULES_PRESET_SCHEMA = "mincho.defineRulesPreset";
  type DefineRulesPresetSerializationCase = {
    caseId: string;
    expectedEvaluation: "serialized" | "not-serialized";
    expectedRegistryInstances: number;
    expectedSourceSnippets: readonly string[];
    relativePath: string;
  };

  type DefineRulesPresetSerializationFixtureCase =
    DefineRulesPresetSerializationCase & {
      fixturePath: string;
    };

  type DefineRulesPresetRegistryResult = Awaited<
    ReturnType<typeof processDefineRulesPresetRegistryFile>
  >;

  type DefineRulesPresetSerializationPaths = {
    consumer: string;
  };

  type DefineRulesPresetSerializationManifest = {
    DEFINE_RULES_PRESET_SERIALIZATION_PATHS: DefineRulesPresetSerializationPaths;
    DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES: readonly DefineRulesPresetSerializationCase[];
    createDefineRulesPresetSerializationFixturePath: (
      relativePath: string
    ) => string;
  };

  let consumerFixturePath: string;
  let registryFixtureMatrixCases: DefineRulesPresetSerializationFixtureCase[] =
    [];
  let serializedRegistryFixtureCases: DefineRulesPresetSerializationFixtureCase[] =
    [];

  function getDefineRulesPresetSerializationManifestUrl(): string {
    return new URL(
      "../../integration/src/__fixtures__/defineRules-preset-serialization/manifest.ts",
      import.meta.url
    ).href;
  }

  async function loadDefineRulesPresetSerializationManifest(): Promise<DefineRulesPresetSerializationManifest> {
    return (await import(
      getDefineRulesPresetSerializationManifestUrl()
    )) as DefineRulesPresetSerializationManifest;
  }

  function createFixtureMatrixCases(
    fixtureCases: readonly DefineRulesPresetSerializationCase[],
    createFixturePath: (relativePath: string) => string
  ): DefineRulesPresetSerializationFixtureCase[] {
    return fixtureCases.map((fixtureCase) => ({
      ...fixtureCase,
      fixturePath: createFixturePath(fixtureCase.relativePath)
    }));
  }

  function initializeDefineRulesPresetSerializationFixtures(
    manifest: DefineRulesPresetSerializationManifest
  ): void {
    const {
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS,
      DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES,
      createDefineRulesPresetSerializationFixturePath
    } = manifest;

    consumerFixturePath = createDefineRulesPresetSerializationFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.consumer
    );
    registryFixtureMatrixCases = createFixtureMatrixCases(
      DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES,
      createDefineRulesPresetSerializationFixturePath
    );
    serializedRegistryFixtureCases = registryFixtureMatrixCases.filter(
      (fixtureCase) => fixtureCase.expectedEvaluation === "serialized"
    );
  }

  beforeAll(async () => {
    initializeDefineRulesPresetSerializationFixtures(
      await loadDefineRulesPresetSerializationManifest()
    );
  });

  interface MockLoadArgs {
    path: string;
    pluginData?: {
      path?: string;
      mainFilePath?: string;
    };
  }

  interface MockResolveArgs {
    path: string;
    importer: string;
    pluginData?: {
      mainFilePath?: string;
    };
  }

  type ScriptLoadResult = {
    contents: string;
    loader: ScriptLoader;
    pluginData: {
      mainFilePath: string;
    };
  };

  type ResolvedExtractedCssResult = {
    namespace: string;
    path: string;
    pluginData: {
      path: string;
      mainFilePath: string;
    };
  };

  type ExtractedCssLoadResult = {
    contents: string;
    loader: string;
    resolveDir: string;
  };

  type LoadCallback = (args: MockLoadArgs) => Promise<unknown>;
  type ResolveCallback = (args: MockResolveArgs) => Promise<unknown>;
  type TestEsbuildApi = Parameters<typeof compile>[0]["esbuild"];

  function createBuildHarness({
    absWorkingDir = "/workspace",
    esbuild,
    minify = false,
    plugin = minchoEsbuildPlugin(),
    resolve: resolveImport
  }: {
    absWorkingDir?: string;
    esbuild?: TestEsbuildApi;
    minify?: boolean;
    plugin?: EsbuildPlugin;
    resolve?: PluginBuild["resolve"];
  } = {}) {
    let extractedCssResolveCallback: ResolveCallback | undefined;
    let extractedCssLoadCallback: LoadCallback | undefined;
    let scriptLoadCallback: LoadCallback | undefined;
    let endCallback: (() => void) | undefined;

    const build = {
      esbuild: esbuild ?? {},
      initialOptions: {
        absWorkingDir,
        minify
      },
      async resolve(path: string, options?: { importer?: string }) {
        if (resolveImport) {
          return resolveImport(path, options);
        }

        const importer = options?.importer ?? join(absWorkingDir, "entry.ts");
        const resolvedPath = resolveStaticCssEvalImportFromFileSystem(
          importer,
          path
        );

        return resolvedPath
          ? createStaticCssEvalResolveResult(resolvedPath)
          : {
              errors: [],
              warnings: [],
              path: "",
              external: false,
              sideEffects: true,
              namespace: "",
              suffix: "",
              pluginData: undefined
            };
      },
      onResolve(_options: { filter: RegExp }, callback: ResolveCallback): void {
        extractedCssResolveCallback = callback;
      },
      onLoad(
        options: { filter: RegExp; namespace?: string },
        callback: LoadCallback
      ): void {
        if (options.namespace === "extracted-css") {
          extractedCssLoadCallback = callback;
          return;
        }

        scriptLoadCallback = callback;
      },
      onEnd(callback: () => void): void {
        endCallback = callback;
      }
    } as unknown as Parameters<EsbuildPlugin["setup"]>[0];

    plugin.setup(build);

    return {
      endBuild() {
        endCallback?.();
      },
      async loadScript(args: MockLoadArgs) {
        if (scriptLoadCallback == null) {
          throw new Error("Missing script onLoad callback");
        }

        return scriptLoadCallback(args);
      },
      async resolveExtractedCss(args: MockResolveArgs) {
        if (extractedCssResolveCallback == null) {
          throw new Error("Missing extracted-css onResolve callback");
        }

        return extractedCssResolveCallback(args);
      },
      async loadExtractedCss(args: MockLoadArgs) {
        if (extractedCssLoadCallback == null) {
          throw new Error("Missing extracted-css onLoad callback");
        }

        return extractedCssLoadCallback(args);
      }
    };
  }

  function readFixtureSource(filePath: string): string {
    return fs.readFileSync(filePath, "utf8");
  }

  function normalizeFixtureSourceWhitespace(source: string): string {
    return source.replace(/\s+/g, " ").trim();
  }

  function expectSourceToContainSnippet(source: string, snippet: string): void {
    expect(normalizeFixtureSourceWhitespace(source)).toContain(
      normalizeFixtureSourceWhitespace(snippet)
    );
  }

  function createEmptyRegistrySession(): DefineRulesPresetRegistryResult["registrySession"] {
    return {
      instances: [],
      nextRegistrationIndex: 0,
      nextRegistrationIndexByFileScope: {}
    };
  }

  function createRegistryResult(
    source: string
  ): DefineRulesPresetRegistryResult {
    return {
      source,
      registrySession: createEmptyRegistrySession()
    };
  }

  function createV4PresetBuildSource(className: string): string {
    return `
      export const preset = {
        schema: "${DEFINE_RULES_PRESET_SCHEMA}",
        version: 4,
        classNameByCache: {
          shared: "${className}"
        },
        writeKeyByCacheKey: {
          shared: 0
        },
        conditionById: {
          0: {
            layer: null,
            supports: null,
            media: null,
            container: null,
            selector: "&"
          }
        },
        propertyById: {
          0: "background"
        },
        writeKeyById: {
          0: {
            conditionId: 0,
            propertyId: 0
          }
        }
      };
      export const shared = "${className}";
    `;
  }

  function expectSourceToContainV4PresetArtifact(source: string): void {
    expect(source).toMatch(
      new RegExp(
        `["']?schema["']?\\s*:\\s*["']${escapeRegExp(DEFINE_RULES_PRESET_SCHEMA)}["']`
      )
    );
    expect(source).toMatch(/["']?version["']?\s*:\s*4/);
    expect(source).toMatch(/["']?classNameByCache["']?\s*:\s*\{/);
    expect(source).toMatch(/["']?writeKeyByCacheKey["']?\s*:\s*\{/);
    expect(source).toMatch(/["']?conditionById["']?\s*:\s*\{/);
    expect(source).toMatch(/["']?propertyById["']?\s*:\s*\{/);
    expect(source).toMatch(/["']?writeKeyById["']?\s*:\s*\{/);
    expectSourceV4PresetArtifactToOmitRuntimeFields(source);
  }

  function expectSourceV4PresetArtifactToOmitRuntimeFields(
    source: string
  ): void {
    const artifactSource = extractV4PresetArtifactSource(source);
    expect(artifactSource).not.toMatch(/["']?registeredSegments["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?segmentCache["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?fullResultCache["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?atomicClassByClassName["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?cx["']?\s*:/);
  }

  function extractV4PresetArtifactSource(source: string): string {
    const schemaMatch = source.match(
      new RegExp(
        `["']?schema["']?\\s*:\\s*["']${escapeRegExp(DEFINE_RULES_PRESET_SCHEMA)}["']`
      )
    );
    if (schemaMatch?.index == null) {
      throw new Error("Expected defineRules preset schema in source");
    }

    const artifactStart = source.lastIndexOf("{", schemaMatch.index);
    if (artifactStart === -1) {
      throw new Error("Expected defineRules preset artifact object in source");
    }

    let depth = 0;
    for (let index = artifactStart; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth === 0) {
        return source.slice(artifactStart, index + 1);
      }
    }

    throw new Error("Expected defineRules preset artifact object to close");
  }

  function expectSourceToContainPopulatedClassNameByCache(
    source: string
  ): void {
    expect(source).toMatch(
      /["']?classNameByCache["']?\s*:\s*\{[\s\S]*["'][^"']+["']/
    );
  }

  function expectSourceToContainClassNameByCacheValue(
    source: string,
    className: string
  ): void {
    expectSourceToContainV4PresetArtifact(source);
    expect(source).toMatch(
      new RegExp(
        `["']?classNameByCache["']?\\s*:\\s*\\{[\\s\\S]*["']${escapeRegExp(className)}["']`
      )
    );
  }

  function countV4PresetArtifacts(source: string): number {
    return Array.from(
      source.matchAll(
        /["']?schema["']?\s*:\s*["']mincho\.defineRulesPreset["']/g
      )
    ).length;
  }

  function createLivePresetBuildSource(): string {
    return `
      import { defineRules } from "@mincho-js/css";

      export const { css, preset } = defineRules({ properties: { background: true } });
      export const fillBlue = css({ background: "blue" });
    `;
  }

  function createLivePresetSmokeEntrySource(): string {
    return `
      import { css as vanillaCss, defineRules } from "@mincho-js/css";

      export const { css: presetCss, preset } = defineRules({
        debugId: "esbuild-build-smoke",
        properties: {
          background: true
        }
      });
      export const fillBlue = vanillaCss([
        presetCss({ background: "blue" })
      ]);
    `;
  }

  async function createLivePresetSmokeFixture(prefix: string) {
    const cacheRoot = join(process.cwd(), "packages/esbuild/.cache");
    await fs.promises.mkdir(cacheRoot, { recursive: true });
    const root = await fs.promises.mkdtemp(join(cacheRoot, prefix));
    const srcRoot = join(root, "src");
    const entryPath = join(srcRoot, "entry.ts");
    await fs.promises.mkdir(srcRoot, { recursive: true });
    await fs.promises.writeFile(entryPath, createLivePresetSmokeEntrySource());

    return {
      entryPath,
      root
    };
  }

  function createJsxCssPropFixtureSource(): string {
    return `
      function App() {
        return <div className="base" css={{ color: "red" }} />;
      }
    `;
  }

  function createJsxCssPropV2ClassValueFixtureSource(): string {
    return `
      const styleA = "style-a";
      const styleB = ["style-b"];
      const spreadProps = {
        className: "from-spread",
        css: "leaked-css",
        id: "root"
      };
      const motion = { div: "div" };

      function Button(props) {
        return <button {...props} />;
      }

      function App() {
        return <>
          <Button css={styleA} />
          <motion.div css={styleB} />
        </>;
      }

      function SpreadApp() {
        return <div {...spreadProps} css={styleA} />;
      }
    `;
  }

  async function createJsxCssPropFixture(
    prefix: string,
    source = createJsxCssPropFixtureSource()
  ) {
    const cacheRoot = join(process.cwd(), "packages/esbuild/.cache");
    await fs.promises.mkdir(cacheRoot, { recursive: true });
    const root = await fs.promises.mkdtemp(join(cacheRoot, prefix));
    const srcRoot = join(root, "src");
    const entryPath = join(srcRoot, "entry.tsx");
    await fs.promises.mkdir(srcRoot, { recursive: true });
    await fs.promises.writeFile(entryPath, source, "utf8");

    return {
      entryPath,
      root,
      source
    };
  }

  function createImportedCssPropEntrySource(
    importPath = "./styles",
    cssExpression = "button"
  ): string {
    return `
      import { button } from "${importPath}";

      function App() {
        return <div css={${cssExpression}} />;
      }

      export { App };
    `;
  }

  function createImportedCssPropStaticRuleEntrySource(
    importPath = "./styles",
    importedName = "button"
  ): string {
    return `
      import { ${importedName} } from "${importPath}";

      function App() {
        return <div css={{ color: ${importedName} }} />;
      }

      export { App };
    `;
  }

  function createImportedStyleSource(color: string): string {
    return `export const button = { color: "${color}" } as const;`;
  }

  async function createImportedCssPropEsbuildFixture(
    prefix: string,
    options: {
      entrySource?: string;
      styleSource?: string;
    } = {}
  ) {
    const cacheRoot = join(process.cwd(), "packages/esbuild/.cache");
    await fs.promises.mkdir(cacheRoot, { recursive: true });
    const root = await fs.promises.mkdtemp(join(cacheRoot, prefix));
    const srcRoot = join(root, "src");
    const entryPath = join(srcRoot, "entry.tsx");
    const stylesPath = join(srcRoot, "styles.ts");
    const entrySource =
      options.entrySource ?? createImportedCssPropEntrySource();
    const styleSource = options.styleSource ?? createImportedStyleSource("red");

    await fs.promises.mkdir(srcRoot, { recursive: true });
    await fs.promises.writeFile(entryPath, entrySource, "utf8");
    await fs.promises.writeFile(stylesPath, styleSource, "utf8");

    return {
      entryPath,
      entrySource,
      root,
      srcRoot,
      stylesPath,
      styleSource
    };
  }

  function collectEsbuildOutputTexts(result: {
    outputFiles?: Array<{ path: string; text: string }>;
  }): {
    all: string;
    css: string;
    js: string;
  } {
    const outputFiles = result.outputFiles ?? [];
    const js = outputFiles
      .filter((outputFile) => /\.(?:mjs|js)$/.test(outputFile.path))
      .map((outputFile) => outputFile.text)
      .join("\n");
    const css = outputFiles
      .filter((outputFile) => outputFile.path.endsWith(".css"))
      .map((outputFile) => outputFile.text)
      .join("\n");

    return {
      all: outputFiles.map((outputFile) => outputFile.text).join("\n"),
      css,
      js
    };
  }

  function expectCssPropBuildOutputToContainColor(
    output: { all: string; css: string; js: string },
    color: string
  ): void {
    expect(output.css).toContain(`color: ${color};`);
    expect(output.js).not.toContain(" css=");
    expect(output.js).not.toContain("css={");
  }

  function createRealRegistryBuildEntrySource(
    fixtureCase: DefineRulesPresetSerializationFixtureCase,
    _fixtureSource: string
  ): string {
    if (fixtureCase.caseId === "registry-helper-wrapped-executed") {
      return `
        import { css, defineRules } from "@mincho-js/css";
        function createPresetOwner() {
          return defineRules({ properties: { color: true, display: true } });
        }
        const presetOwner = createPresetOwner();
        export const { css: presetCss, preset } = presetOwner;
        export const shared = presetCss({ color: "rebeccapurple", display: "flex" });
        export const __registryBuildMarker = css([shared]);
        export const __registryBuildPresetArtifact = JSON.stringify(preset);
      `;
    }

    if (fixtureCase.caseId === "registry-iife-executed") {
      return `
        import { css, defineRules } from "@mincho-js/css";
        const presetOwner = (() => defineRules({ properties: { color: true, display: true } }))();
        export const { css: presetCss, preset } = presetOwner;
        export const shared = presetCss({ color: "rebeccapurple", display: "flex" });
        export const __registryBuildMarker = css([shared]);
        export const __registryBuildPresetArtifact = JSON.stringify(preset);
      `;
    }

    if (fixtureCase.caseId === "registry-nested-function-executed") {
      return `
        import { css, defineRules } from "@mincho-js/css";
        function createPresetOwner() {
          return defineRules({ properties: { color: true, display: true } });
        }
        const presetOwner = createPresetOwner();
        export const { css: presetCss, preset } = presetOwner;
        export const shared = presetCss({ color: "rebeccapurple", display: "flex" });
        export const __registryBuildMarker = css([shared]);
        export const __registryBuildPresetArtifact = JSON.stringify(preset);
      `;
    }

    if (fixtureCase.caseId === "registry-multiple-instances") {
      return `
        import { css, defineRules } from "@mincho-js/css";
        const primaryPresetOwner = defineRules({ properties: { color: true, display: true } });
        const secondaryPresetOwner = defineRules({ properties: { padding: true, margin: true } });
        export const { css: primaryCss, preset: primaryPreset } = primaryPresetOwner;
        export const secondaryPreset = secondaryPresetOwner.preset;
        export const shared = primaryCss({ color: "rebeccapurple", display: "flex" });
        export const secondaryShared = secondaryPresetOwner.css({ padding: 17, margin: 7 });
        export const __registryBuildMarker = css([shared, secondaryShared]);
        export const __registryBuildPresetArtifacts = [
          JSON.stringify(primaryPreset),
          JSON.stringify(secondaryPreset)
        ];
      `;
    }

    if (fixtureCase.caseId === "registry-imported-helper-executed") {
      return `
        import { css } from "@mincho-js/css";
        import { createPresetOwner } from "./helper";
        const presetOwner = createPresetOwner();
        export const { css: presetCss, preset } = presetOwner;
        export const shared = presetCss({ color: "rebeccapurple", display: "flex" });
        export const __registryBuildMarker = css([shared]);
        export const __registryBuildPresetArtifact = JSON.stringify(preset);
      `;
    }

    return _fixtureSource;
  }

  async function createRealEsbuildRegistryFixture(
    fixtureCase: DefineRulesPresetSerializationFixtureCase
  ) {
    const cacheRoot = join(process.cwd(), "packages/esbuild/.cache");
    await fs.promises.mkdir(cacheRoot, { recursive: true });
    const root = await fs.promises.mkdtemp(
      join(cacheRoot, `${fixtureCase.caseId}-`)
    );
    const srcRoot = join(root, "src");
    await fs.promises.cp(dirname(fixtureCase.fixturePath), srcRoot, {
      recursive: true
    });
    const fixtureSource = await fs.promises.readFile(
      join(srcRoot, "index.css.ts"),
      "utf8"
    );
    const entrySource = createRealRegistryBuildEntrySource(
      fixtureCase,
      fixtureSource
    );
    const entryPath = join(srcRoot, "entry.ts");
    await fs.promises.writeFile(entryPath, entrySource);

    return {
      entryPath,
      root
    };
  }

  async function buildRealEsbuildRegistryFixture(
    fixtureCase: DefineRulesPresetSerializationFixtureCase
  ) {
    const realEsbuild = await import("esbuild");
    const { entryPath, root } =
      await createRealEsbuildRegistryFixture(fixtureCase);

    const fixtureSource = await fs.promises.readFile(
      join(root, "src/index.css.ts"),
      "utf8"
    );
    const babelTransformSpy = vi
      .spyOn(integrationHelpers, "babelTransform")
      .mockResolvedValue({
        code: 'import "extracted_registry.css.ts";\nexport const __registryBuildMarker = "entry";',
        result: ["extracted_registry.css.ts", fixtureSource]
      });
    const registrySources: string[] = [];
    const processRegistryFile =
      integrationHelpers.processDefineRulesPresetRegistryFile;
    integrationHelpers.processDefineRulesPresetRegistryFile = async (
      options
    ) => {
      const result = await processRegistryFile(options);
      registrySources.push(result.source);
      return result;
    };

    try {
      const result = await realEsbuild.build({
        absWorkingDir: root,
        bundle: true,
        entryPoints: [entryPath],
        external: ["@mincho-js/css"],
        format: "esm",
        minify: false,
        outdir: join(root, "dist"),
        plugins: minchoEsbuildPlugins(),
        write: false
      });
      const jsOutput = result.outputFiles.find((outputFile) =>
        outputFile.path.endsWith(".js")
      );
      const cssOutput = result.outputFiles.find((outputFile) =>
        outputFile.path.endsWith(".css")
      );

      if (jsOutput == null) {
        throw new Error("Expected esbuild registry build to emit a JS file");
      }

      return {
        css: cssOutput?.text ?? "",
        js: jsOutput.text,
        registrySource: registrySources.join("\n")
      };
    } finally {
      integrationHelpers.processDefineRulesPresetRegistryFile =
        processRegistryFile;
      babelTransformSpy.mockRestore();
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractFillBlueClassName(source: string): string {
    const match = source.match(/fillBlue\s*=\s*["']([^"']+)["']/);
    if (match?.[1] == null) {
      throw new Error(
        "Expected build output to include a fillBlue class literal"
      );
    }

    return match[1];
  }

  function extractExportedVariableInitFromBuildSource(
    source: string,
    exportName: string
  ): string {
    const inlineExportedVariableMatch = new RegExp(
      `\\bexport\\s+(?:const|let|var)\\s+${escapeRegExp(exportName)}\\s*=\\s*([^;]+);`
    ).exec(source);
    if (inlineExportedVariableMatch?.[1] != null) {
      return inlineExportedVariableMatch[1].trim();
    }

    const namedExportMatch = Array.from(
      source.matchAll(/\bexport\s*\{([\s\S]*?)\}\s*;/g)
    ).find(([, exportSpecifiers]) =>
      exportSpecifiers
        ?.split(",")
        .some(
          (specifier) => specifier.trim().split(/\s+as\s+/)[0] === exportName
        )
    );
    if (namedExportMatch == null) {
      throw new Error(`Failed to locate exported variable ${exportName}`);
    }

    const variableMatch = new RegExp(
      `\\b(?:const|let|var)\\s+${escapeRegExp(exportName)}\\s*=\\s*([^;]+);`
    ).exec(source);

    if (variableMatch?.[1] == null) {
      throw new Error(`Failed to locate exported variable ${exportName}`);
    }

    return variableMatch[1].trim();
  }

  function extractExportedStringValueFromBuildSource(
    source: string,
    exportName: string
  ): string {
    const exportedInit = extractExportedVariableInitFromBuildSource(
      source,
      exportName
    );
    const stringLiteralMatch = /^(?:"([^"]+)"|'([^']+)')$/.exec(exportedInit);

    if (stringLiteralMatch == null) {
      throw new Error(`Expected export ${exportName} to be a string literal`);
    }

    return stringLiteralMatch[1] ?? stringLiteralMatch[2]!;
  }

  function splitClassNames(className: string): string[] {
    return className.split(/\s+/).filter(Boolean);
  }

  function expectCssSourceToContainClassNames(
    source: string,
    className: string
  ): void {
    for (const fragmentClassName of splitClassNames(className)) {
      expect(source).toContain(`.${fragmentClassName}`);
    }
  }

  function hasCssCallWithStringProperty(
    source: string,
    propertyName: string,
    propertyValue: string
  ): boolean {
    return new RegExp(
      `\\bcss\\s*\\(\\s*\\{[\\s\\S]*?${escapeRegExp(propertyName)}\\s*:\\s*["']${escapeRegExp(propertyValue)}["'][\\s\\S]*?\\}\\s*\\)`
    ).test(source);
  }

  function extractCssPropSidecarImport(code: string): {
    file: string;
    localNames: string[];
  } {
    const sidecarImportMatch =
      /import \{ ([^}]+) \} from "(extracted_[^"]+\.css\.ts)";/.exec(code);

    if (sidecarImportMatch == null) {
      throw new Error(
        "Expected transformed code to import an extracted sidecar"
      );
    }

    return {
      file: sidecarImportMatch[2]!,
      localNames: [
        ...(sidecarImportMatch[1]?.matchAll(
          /(?:^|, )([A-Za-z_$][\w$]*)(?: as ([A-Za-z_$][\w$]*))?/g
        ) ?? [])
      ].map(([, importedName, localName]) => localName ?? importedName)
    };
  }

  function extractCxIdentifierFromSource(source: string): string {
    const cxImportMatch =
      /import \{ [^}]*\bcx(?: as ([A-Za-z_$][\w$]*))?[^}]*\} from "@mincho-js\/css";/.exec(
        source
      );

    if (cxImportMatch == null) {
      throw new Error("Expected transformed source to import cx");
    }

    return cxImportMatch[1] ?? "cx";
  }

  function expectSourceToContainV2ClassValueCssPropLowering(
    source: string,
    cxIdentifier: string
  ): void {
    expect(source).toMatch(
      new RegExp(
        `<Button className=\\{${escapeRegExp(cxIdentifier)}\\(styleA\\)\\} />`
      )
    );
    expect(source).toMatch(/<motion\.div className=\{[A-Za-z_$][\w$]*\} \/>/);
    expect(source).not.toContain(`${cxIdentifier}(styleB)`);
    expect(source).toContain("css: _minchoCssProp");
    expect(source).toContain("..._minchoRest");
    expect(source).toMatch(
      new RegExp(
        `className=\\{${escapeRegExp(cxIdentifier)}\\(_minchoClassName, styleA\\)\\}`
      )
    );
  }

  function createDeferred<Value>() {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<Value>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });

    return {
      promise,
      resolve,
      reject
    };
  }

  async function spyOnSourceBabelTransform() {
    const sourceIntegrationUrl = new URL(
      "../../integration/src/babel" + ".ts",
      import.meta.url
    ).href;
    const sourceIntegrationModule = (await import(
      /* @vite-ignore */ sourceIntegrationUrl
    )) as {
      babelTransform: typeof babelTransform;
    };

    return vi
      .spyOn(integrationHelpers, "babelTransform")
      .mockImplementation(sourceIntegrationModule.babelTransform);
  }

  async function loadExtractedCssFromEntry(
    harness: ReturnType<typeof createBuildHarness>,
    entryPath = "/workspace/src/app.ts",
    extractedPath = "extracted_rules.css.ts"
  ) {
    const scriptLoadResult = (await harness.loadScript({
      path: entryPath
    })) as ScriptLoadResult;
    const resolveResult = (await harness.resolveExtractedCss({
      path: extractedPath,
      importer: entryPath,
      pluginData: scriptLoadResult.pluginData
    })) as ResolvedExtractedCssResult;
    const loadResult = (await harness.loadExtractedCss({
      path: resolveResult.path,
      pluginData: resolveResult.pluginData
    })) as ExtractedCssLoadResult;

    return {
      loadResult,
      resolveResult,
      scriptLoadResult
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves directory imports to index files", async () => {
    const { entryPath, root } = await createJsxCssPropFixture(
      "static-css-resolve-directory-"
    );
    const directoryPath = join(root, "src", "styles");
    const indexPath = join(directoryPath, "index.ts");
    await fs.promises.mkdir(directoryPath);
    await fs.promises.writeFile(indexPath, "export const button = {};", "utf8");

    try {
      expect(
        resolveStaticCssEvalImportFromFileSystem(entryPath, "./styles")
      ).toBe(indexPath);
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  describe("minchoEsbuildPlugin", () => {
    it("loads a TSX fixture with jsxCssProp enabled and registers extracted css sidecar content", async () => {
      const { entryPath, root } = await createJsxCssPropFixture(
        "jsx-css-prop-enabled-"
      );
      const babelTransformSpy = await spyOnSourceBabelTransform();
      const compileSpy = vi
        .spyOn(integrationHelpers, "compile")
        .mockResolvedValue({
          source: "compiled source"
        } as Awaited<ReturnType<typeof compile>>);
      vi.spyOn(
        integrationHelpers,
        "processDefineRulesPresetRegistryFile"
      ).mockResolvedValue(createRegistryResult("registered source"));

      try {
        const harness = createBuildHarness({
          plugin: minchoEsbuildPlugin({ jsxCssProp: true })
        });
        const scriptLoadResult = (await harness.loadScript({
          path: entryPath
        })) as ScriptLoadResult;
        const { file: sidecarFile, localNames: sidecarLocalNames } =
          extractCssPropSidecarImport(scriptLoadResult.contents);
        const cxImportMatch =
          /import \{ [^}]*\bcx(?: as ([A-Za-z_$][\w$]*))?[^}]*\} from "@mincho-js\/css";/.exec(
            scriptLoadResult.contents
          );
        const cxIdentifier = cxImportMatch?.[1] ?? "cx";
        const classNameMergeMatch =
          /className=\{([A-Za-z_$][\w$]*)\("base", ([A-Za-z_$][\w$]*)\)\}/.exec(
            scriptLoadResult.contents
          );

        expect(babelTransformSpy).toHaveBeenCalledWith(
          entryPath,
          expect.objectContaining({
            jsxCssProp: true,
            staticCssEvalSourceProvider: expect.any(Object)
          })
        );
        expect(scriptLoadResult.loader).toBe("tsx");
        expect(scriptLoadResult.contents).not.toContain(" css=");
        expect(scriptLoadResult.contents).not.toContain("css={{");
        expect(scriptLoadResult.contents).not.toContain('color: "red"');
        expect(cxImportMatch).not.toBeNull();
        expect(classNameMergeMatch).not.toBeNull();
        expect(classNameMergeMatch?.[1]).toBe(cxIdentifier);
        expect(sidecarLocalNames).toContain(classNameMergeMatch?.[2]);

        const resolveResult = (await harness.resolveExtractedCss({
          path: sidecarFile,
          importer: entryPath,
          pluginData: scriptLoadResult.pluginData
        })) as ResolvedExtractedCssResult;
        const loadResult = (await harness.loadExtractedCss({
          path: resolveResult.path,
          pluginData: resolveResult.pluginData
        })) as ExtractedCssLoadResult;
        const compileOptions = compileSpy.mock.calls[0]?.[0];

        if (compileOptions == null) {
          throw new Error("Expected extracted css sidecar to be compiled");
        }

        expect(resolveResult).toEqual({
          namespace: "extracted-css",
          path: join(entryPath, "..", sidecarFile),
          pluginData: {
            path: sidecarFile,
            mainFilePath: entryPath
          }
        });
        expect(compileOptions).toEqual(
          expect.objectContaining({
            filePath: resolveResult.path,
            originalPath: entryPath,
            contents: expect.any(String)
          })
        );
        expect(compileOptions.contents).toContain("@mincho-js/css");
        expect(compileOptions.contents).toMatch(
          /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*css\(\{\s*color: "red"\s*\}\);/s
        );
        expect(loadResult.contents).toBe("registered source");
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    });

    it("lowers v2 class-value component and pre-css spread css props with jsxCssProp enabled", async () => {
      const { entryPath, root } = await createJsxCssPropFixture(
        "jsx-css-prop-v2-class-value-",
        createJsxCssPropV2ClassValueFixtureSource()
      );
      const babelTransformSpy = await spyOnSourceBabelTransform();

      try {
        const harness = createBuildHarness({
          plugin: minchoEsbuildPlugin({ jsxCssProp: true })
        });
        const scriptLoadResult = (await harness.loadScript({
          path: entryPath
        })) as ScriptLoadResult;
        const cxIdentifier = extractCxIdentifierFromSource(
          scriptLoadResult.contents
        );
        const missingResolveResult = await harness.resolveExtractedCss({
          path: "extracted_missing.css.ts",
          importer: entryPath,
          pluginData: scriptLoadResult.pluginData
        });

        expect(babelTransformSpy).toHaveBeenCalledWith(
          entryPath,
          expect.objectContaining({
            jsxCssProp: true,
            staticCssEvalSourceProvider: expect.any(Object)
          })
        );
        expect(scriptLoadResult.loader).toBe("tsx");
        expect(scriptLoadResult.contents).not.toContain(" css=");
        expect(scriptLoadResult.contents).not.toContain("css={styleA}");
        expect(scriptLoadResult.contents).not.toContain("css={styleB}");
        expect(scriptLoadResult.contents).not.toContain("css(styleA)");
        expect(scriptLoadResult.contents).not.toContain("_css(styleA)");
        expectSourceToContainV2ClassValueCssPropLowering(
          scriptLoadResult.contents,
          cxIdentifier
        );
        expect(missingResolveResult).toBeUndefined();
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    });

    it("forwards jsxCssProp through the exported plugin array", async () => {
      const { entryPath, root } = await createJsxCssPropFixture(
        "jsx-css-prop-plugin-array-",
        createJsxCssPropV2ClassValueFixtureSource()
      );
      const minchoPlugin = minchoEsbuildPlugins({ jsxCssProp: true })[0];
      const babelTransformSpy = await spyOnSourceBabelTransform();

      if (minchoPlugin == null) {
        throw new Error(
          "Expected exported plugin array to include Mincho plugin"
        );
      }

      try {
        const harness = createBuildHarness({ plugin: minchoPlugin });
        const scriptLoadResult = (await harness.loadScript({
          path: entryPath
        })) as ScriptLoadResult;
        const cxIdentifier = extractCxIdentifierFromSource(
          scriptLoadResult.contents
        );

        expect(babelTransformSpy).toHaveBeenCalledWith(
          entryPath,
          expect.objectContaining({
            jsxCssProp: true,
            staticCssEvalSourceProvider: expect.any(Object)
          })
        );
        expect(scriptLoadResult.contents).not.toContain(" css=");
        expectSourceToContainV2ClassValueCssPropLowering(
          scriptLoadResult.contents,
          cxIdentifier
        );
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    });

    it("refreshes imported static css prop dependencies across esbuild rebuilds without stale CSS", async () => {
      const realEsbuild = await import("esbuild");
      const fixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-imported-rebuild-"
      );
      await spyOnSourceBabelTransform();
      const context = await realEsbuild.context({
        absWorkingDir: fixture.root,
        bundle: true,
        entryPoints: [fixture.entryPath],
        external: ["@mincho-js/css"],
        format: "esm",
        minify: false,
        outdir: join(fixture.root, "dist"),
        plugins: minchoEsbuildPlugins({ jsxCssProp: true }),
        write: false
      });

      try {
        const redOutput = collectEsbuildOutputTexts(await context.rebuild());

        expectCssPropBuildOutputToContainColor(redOutput, "red");
        expect(redOutput.all).not.toContain("color: blue");

        await fs.promises.writeFile(
          fixture.stylesPath,
          createImportedStyleSource("blue"),
          "utf8"
        );

        const blueOutput = collectEsbuildOutputTexts(await context.rebuild());

        expectCssPropBuildOutputToContainColor(blueOutput, "blue");
        expect(blueOutput.all).not.toContain("color: red");
      } finally {
        await context.dispose();
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    }, 20000);

    it("scopes imported static css eval source caches to independent esbuild build contexts", async () => {
      const realEsbuild = await import("esbuild");
      const redFixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-cache-scope-red-",
        { styleSource: createImportedStyleSource("red") }
      );
      const blueFixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-cache-scope-blue-",
        { styleSource: createImportedStyleSource("blue") }
      );
      await spyOnSourceBabelTransform();
      const sharedMinchoPlugin = minchoEsbuildPlugin({ jsxCssProp: true });
      const redContext = await realEsbuild.context({
        absWorkingDir: redFixture.root,
        bundle: true,
        entryPoints: [redFixture.entryPath],
        external: ["@mincho-js/css"],
        format: "esm",
        minify: false,
        outdir: join(redFixture.root, "dist"),
        plugins: [sharedMinchoPlugin, vanillaExtractPlugin()],
        write: false
      });
      const blueContext = await realEsbuild.context({
        absWorkingDir: blueFixture.root,
        bundle: true,
        entryPoints: [blueFixture.entryPath],
        external: ["@mincho-js/css"],
        format: "esm",
        minify: false,
        outdir: join(blueFixture.root, "dist"),
        plugins: [sharedMinchoPlugin, vanillaExtractPlugin()],
        write: false
      });

      try {
        const redOutput = collectEsbuildOutputTexts(await redContext.rebuild());
        const blueOutput = collectEsbuildOutputTexts(
          await blueContext.rebuild()
        );

        expectCssPropBuildOutputToContainColor(redOutput, "red");
        expect(redOutput.all).not.toContain("color: blue");
        expectCssPropBuildOutputToContainColor(blueOutput, "blue");
        expect(blueOutput.all).not.toContain("color: red");
      } finally {
        await Promise.all([redContext.dispose(), blueContext.dispose()]);
        await Promise.all([
          fs.promises.rm(redFixture.root, { force: true, recursive: true }),
          fs.promises.rm(blueFixture.root, { force: true, recursive: true })
        ]);
      }
    }, 20000);

    it("refuses virtual, package, and node_modules static css evaluation at esbuild boundaries", async () => {
      const fallbackFixture = await createJsxCssPropFixture(
        "jsx-css-prop-esbuild-boundary-fallback-",
        `
          import { button as virtualButton } from "virtual:styles";
          import { button as packageButton } from "pkg/styles";
          import { button as nodeModuleButton } from "./node_modules/pkg/styles";

          function App() {
            return <>
              <div css={virtualButton} />
              <div css={packageButton} />
              <div css={nodeModuleButton} />
            </>;
          }
        `
      );
      const staticRuleFixture = await createJsxCssPropFixture(
        "jsx-css-prop-esbuild-boundary-static-rule-",
        createImportedCssPropStaticRuleEntrySource(
          "./node_modules/pkg/styles",
          "button"
        )
      );
      await spyOnSourceBabelTransform();

      try {
        await Promise.all([
          fs.promises.mkdir(
            join(fallbackFixture.root, "src/node_modules/pkg"),
            { recursive: true }
          ),
          fs.promises.mkdir(
            join(staticRuleFixture.root, "src/node_modules/pkg"),
            { recursive: true }
          )
        ]);
        await Promise.all([
          fs.promises.writeFile(
            join(fallbackFixture.root, "src/node_modules/pkg/styles.ts"),
            createImportedStyleSource("red"),
            "utf8"
          ),
          fs.promises.writeFile(
            join(staticRuleFixture.root, "src/node_modules/pkg/styles.ts"),
            createImportedStyleSource("red"),
            "utf8"
          )
        ]);

        const fallbackHarness = createBuildHarness({
          absWorkingDir: fallbackFixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true })
        });
        const fallbackResult = (await fallbackHarness.loadScript({
          path: fallbackFixture.entryPath
        })) as ScriptLoadResult;
        const cxIdentifier = extractCxIdentifierFromSource(
          fallbackResult.contents
        );

        expect(fallbackResult.contents).not.toContain("extracted_");
        for (const localName of [
          "virtualButton",
          "packageButton",
          "nodeModuleButton"
        ]) {
          expect(fallbackResult.contents).toMatch(
            new RegExp(
              `className=\\{${escapeRegExp(cxIdentifier)}\\(${localName}\\)\\}`
            )
          );
        }

        const staticRuleHarness = createBuildHarness({
          absWorkingDir: staticRuleFixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true })
        });

        await expect(
          staticRuleHarness.loadScript({ path: staticRuleFixture.entryPath })
        ).rejects.toThrow("Cannot statically evaluate css prop value");
      } finally {
        await Promise.all([
          fs.promises.rm(fallbackFixture.root, {
            force: true,
            recursive: true
          }),
          fs.promises.rm(staticRuleFixture.root, {
            force: true,
            recursive: true
          })
        ]);
      }
    });

    it("returns null when a resolved static css dependency disappears before stat", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-esbuild-disappeared-before-stat-"
      );
      const originalStat = fs.promises.stat.bind(fs.promises);
      const targetRealpath = normalizeStaticCssEvalFileId(
        await fs.promises.realpath(fixture.stylesPath)
      );
      const statSpy = vi
        .spyOn(fs.promises, "stat")
        .mockImplementation(
          async (...args: Parameters<typeof fs.promises.stat>) => {
            const [path] = args;

            if (String(path).replace(/\\/g, "/") === targetRealpath) {
              const missingError = new Error(
                `ENOENT: ${targetRealpath}`
              ) as Error & {
                code?: string;
              };
              missingError.code = "ENOENT";
              throw missingError;
            }

            return originalStat(...args);
          }
        );

      try {
        const resolution = await resolveEsbuildStaticCssEvalImport({
          build: {
            resolve: vi
              .fn()
              .mockResolvedValue(
                createStaticCssEvalResolveResult(fixture.stylesPath)
              )
          } as PluginBuild,
          importerId: fixture.entryPath,
          importPath: "./styles",
          rootRealpath: getRealpathOrResolvedPath(fixture.root)
        });

        expect(resolution).toBeNull();
      } finally {
        statSpy.mockRestore();
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("retransforms owners and drops stale CSS when an imported static dependency is deleted", async () => {
      const realEsbuild = await import("esbuild");
      const fixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-imported-deleted-dependency-"
      );
      await spyOnSourceBabelTransform();
      const context = await realEsbuild.context({
        absWorkingDir: fixture.root,
        bundle: true,
        entryPoints: [fixture.entryPath],
        external: ["@mincho-js/css"],
        format: "esm",
        minify: false,
        outdir: join(fixture.root, "dist"),
        plugins: minchoEsbuildPlugins({ jsxCssProp: true }),
        write: false
      });

      try {
        const redOutput = collectEsbuildOutputTexts(await context.rebuild());

        expectCssPropBuildOutputToContainColor(redOutput, "red");

        await fs.promises.rm(fixture.stylesPath, { force: true });
        await expect(context.rebuild()).rejects.toThrow(
          "Cannot statically evaluate css prop value: failed to resolve project-local dependency ./styles"
        );
      } finally {
        await context.dispose();
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    }, 20000);

    it("leaves TSX css prop unchanged when jsxCssProp is omitted or false", async () => {
      const fixtureCases = [
        {
          prefix: "jsx-css-prop-default-",
          plugin: minchoEsbuildPlugin(),
          expectedBabelOptions: undefined
        },
        {
          prefix: "jsx-css-prop-false-",
          plugin: minchoEsbuildPlugin({ jsxCssProp: false }),
          expectedBabelOptions: { jsxCssProp: false }
        }
      ] as const;

      for (const fixtureCase of fixtureCases) {
        const { entryPath, root } = await createJsxCssPropFixture(
          fixtureCase.prefix
        );
        const babelTransformSpy = vi.spyOn(
          integrationHelpers,
          "babelTransform"
        );

        try {
          const harness = createBuildHarness({ plugin: fixtureCase.plugin });
          const scriptLoadResult = (await harness.loadScript({
            path: entryPath
          })) as ScriptLoadResult;
          const resolveResult = await harness.resolveExtractedCss({
            path: "extracted_missing.css.ts",
            importer: entryPath,
            pluginData: scriptLoadResult.pluginData
          });

          expect(babelTransformSpy).toHaveBeenCalledWith(
            entryPath,
            fixtureCase.expectedBabelOptions
          );
          expect(scriptLoadResult.loader).toBe("tsx");
          expect(scriptLoadResult.contents).toContain('className="base"');
          expect(scriptLoadResult.contents).toContain("css={{");
          expect(scriptLoadResult.contents).toContain('color: "red"');
          expect(scriptLoadResult.contents).not.toMatch(
            /className=\{[A-Za-z_$][\w$]*\("base", [A-Za-z_$][\w$]*\)\}/
          );
          expect(resolveResult).toBeUndefined();
        } finally {
          babelTransformSpy.mockRestore();
          await fs.promises.rm(root, { force: true, recursive: true });
        }
      }
    });

    it("builds a real esbuild fixture and emits defineRules preset registry artifact", async () => {
      const realEsbuild = await import("esbuild");
      const { entryPath, root } = await createLivePresetSmokeFixture(
        "define-rules-esbuild-smoke-"
      );

      try {
        const result = await realEsbuild.build({
          absWorkingDir: root,
          bundle: true,
          entryPoints: [entryPath],
          external: ["@mincho-js/css"],
          format: "esm",
          minify: false,
          outdir: join(root, "dist"),
          plugins: minchoEsbuildPlugins(),
          write: false
        });
        const jsOutput = result.outputFiles.find((outputFile) =>
          outputFile.path.endsWith(".js")
        );
        const cssOutput = result.outputFiles.find((outputFile) =>
          outputFile.path.endsWith(".css")
        );

        if (jsOutput == null) {
          throw new Error("Expected esbuild smoke build to emit a JS file");
        }
        if (cssOutput == null) {
          throw new Error("Expected esbuild smoke build to emit a CSS file");
        }

        const fillBlueClassName = extractFillBlueClassName(jsOutput.text);
        expect(jsOutput.text).not.toContain('background: "blue"');
        expectCssSourceToContainClassNames(cssOutput.text, fillBlueClassName);
        expect(cssOutput.text).toContain("background: blue;");

        vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
          code: 'import "extracted_rules.css.ts";\nexport { css, preset, fillBlue };',
          result: ["extracted_rules.css.ts", createLivePresetBuildSource()]
        });
        const harness = createBuildHarness({
          absWorkingDir: process.cwd(),
          esbuild: realEsbuild
        });
        const { loadResult } = await loadExtractedCssFromEntry(
          harness,
          join(process.cwd(), "packages/esbuild/src/registry-entry.ts")
        );
        const registryClassName = extractExportedStringValueFromBuildSource(
          loadResult.contents,
          "fillBlue"
        );

        expectSourceToContainClassNameByCacheValue(
          loadResult.contents,
          registryClassName
        );
        expectSourceToContainPopulatedClassNameByCache(loadResult.contents);
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    });

    it("real esbuild registry builds helper-wrapped, IIFE, nested, multiple instances, and imported helper fixtures", async () => {
      const realBuildCaseIds = [
        "registry-helper-wrapped-executed",
        "registry-iife-executed",
        "registry-nested-function-executed",
        "registry-multiple-instances",
        "registry-imported-helper-executed"
      ];

      for (const caseId of realBuildCaseIds) {
        const fixtureCase = serializedRegistryFixtureCases.find(
          (candidate) => candidate.caseId === caseId
        );
        if (fixtureCase == null) {
          throw new Error(`Missing registry fixture case ${caseId}`);
        }

        const { registrySource } =
          await buildRealEsbuildRegistryFixture(fixtureCase);

        expect(registrySource).not.toBe("");
        expectSourceToContainV4PresetArtifact(registrySource);
        expectSourceToContainPopulatedClassNameByCache(registrySource);
        if (fixtureCase.expectedRegistryInstances > 1) {
          const artifactCount = Array.from(
            registrySource.matchAll(
              /["']?schema["']?\s*:\s*["']mincho\.defineRulesPreset["']/g
            )
          ).length;
          expect(artifactCount).toBeGreaterThanOrEqual(
            fixtureCase.expectedRegistryInstances
          );
        }
      }
    });

    it("real esbuild function-valued config build skips registry artifacts", async () => {
      const fixtureCase = registryFixtureMatrixCases.find(
        (candidate) => candidate.caseId === "registry-function-config-invalid"
      );
      if (fixtureCase == null) {
        throw new Error("Missing registry function config fixture case");
      }

      const { js, registrySource } =
        await buildRealEsbuildRegistryFixture(fixtureCase);

      expect(registrySource).not.toBe("");
      expect(countV4PresetArtifacts(registrySource)).toBe(0);
      expect(countV4PresetArtifacts(js)).toBe(0);
      expect(registrySource).toContain("rebeccapurple");
    });

    it("serializes live preset output through the esbuild registry path", async () => {
      const livePresetFixtureSource = createLivePresetBuildSource();
      expectSourceToContainSnippet(
        livePresetFixtureSource,
        "export const { css, preset } = defineRules({ properties: { background: true } });"
      );
      expectSourceToContainSnippet(
        livePresetFixtureSource,
        'export const fillBlue = css({ background: "blue" });'
      );

      const realEsbuild = await import("esbuild");
      const entryPath = join(
        process.cwd(),
        "packages/esbuild/src/live-preset-entry.ts"
      );

      vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css, preset, fillBlue };',
        result: ["extracted_rules.css.ts", livePresetFixtureSource]
      });
      const registrySpy = vi.spyOn(
        integrationHelpers,
        "processDefineRulesPresetRegistryFile"
      );

      const harness = createBuildHarness({
        absWorkingDir: process.cwd(),
        esbuild: realEsbuild
      });
      const { loadResult, resolveResult } = await loadExtractedCssFromEntry(
        harness,
        entryPath
      );
      const fillBlueInit = extractExportedVariableInitFromBuildSource(
        loadResult.contents,
        "fillBlue"
      );
      const fillBlueClassName = extractExportedStringValueFromBuildSource(
        loadResult.contents,
        "fillBlue"
      );

      expect(registrySpy).toHaveBeenCalledWith({
        source: expect.any(String),
        filePath: resolveResult.path,
        outputCss: undefined,
        identOption: "debug"
      });
      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(loadResult.loader).toBe("js");
      expect(loadResult.resolveDir).toBe(dirname(resolveResult.path));
      expect(fillBlueInit).toMatch(/^(?:"[^"]+"|'[^']+')$/);
      expect(fillBlueClassName.split(/\s+/)).toHaveLength(1);
      expect(
        hasCssCallWithStringProperty(loadResult.contents, "background", "blue")
      ).toBe(false);
      expectSourceToContainClassNameByCacheValue(
        loadResult.contents,
        fillBlueClassName
      );
    });

    it("defineRules exported css skips function-valued registry artifacts", async () => {
      const functionValuedConfigBuildSource = `
        import { defineRules } from "@mincho-js/css";

        const invalid = defineRules({
          properties: {
            color(value: "brand" | "neutral") {
              return value === "brand" ? "blue" : "gray";
            }
          }
        });
        export const raw = invalid.css.raw({ color: "brand" });
      `;
      const realEsbuild = await import("esbuild");
      const entryPath = join(
        process.cwd(),
        "packages/esbuild/src/function-valued-config-entry.ts"
      );

      vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { raw };',
        result: ["extracted_rules.css.ts", functionValuedConfigBuildSource]
      });
      const registrySpy = vi.spyOn(
        integrationHelpers,
        "processDefineRulesPresetRegistryFile"
      );

      const harness = createBuildHarness({
        absWorkingDir: process.cwd(),
        esbuild: realEsbuild
      });
      const scriptLoadResult = (await harness.loadScript({
        path: entryPath
      })) as ScriptLoadResult;
      const resolveResult = (await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: entryPath,
        pluginData: scriptLoadResult.pluginData
      })) as ResolvedExtractedCssResult;

      const loadResult = (await harness.loadExtractedCss({
        path: resolveResult.path,
        pluginData: resolveResult.pluginData
      })) as ExtractedCssLoadResult;

      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(loadResult.loader).toBe("js");
      expect(countV4PresetArtifacts(loadResult.contents)).toBe(0);
      expect(loadResult.contents).toContain("blue");
    });

    it("routes extracted css through the shared preset registry wrapper without breaking the namespace flow", async () => {
      vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
        code: "export const app = {};",
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationHelpers, "compile").mockResolvedValue({
        source: "compiled source"
      } as Awaited<ReturnType<typeof compile>>);
      const registryStepSpy = vi.spyOn(
        integrationHelpers,
        "runDefineRulesPresetRegistryStep"
      );
      const registrySpy = vi
        .spyOn(integrationHelpers, "processDefineRulesPresetRegistryFile")
        .mockResolvedValue(
          createRegistryResult(createV4PresetBuildSource("shared_class"))
        );

      const harness = createBuildHarness();
      const { loadResult, resolveResult } =
        await loadExtractedCssFromEntry(harness);

      expect(resolveResult).toEqual({
        namespace: "extracted-css",
        path: "/workspace/src/extracted_rules.css.ts",
        pluginData: {
          path: "extracted_rules.css.ts",
          mainFilePath: "/workspace/src/app.ts"
        }
      });
      expect(registryStepSpy).toHaveBeenCalledWith(expect.any(Function));
      expect(registryStepSpy).toHaveBeenCalledTimes(1);
      expect(registrySpy).toHaveBeenCalledWith({
        source: "compiled source",
        filePath: "/workspace/src/extracted_rules.css.ts",
        outputCss: undefined,
        identOption: "debug"
      });
      expect(loadResult.loader).toBe("js");
      expect(loadResult.resolveDir).toBe("/workspace/src");
      expectSourceToContainClassNameByCacheValue(
        loadResult.contents,
        "shared_class"
      );
    });

    it("passes short identifiers to the registry wrapper when esbuild minifies", async () => {
      vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
        code: "export const app = {};",
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationHelpers, "compile").mockResolvedValue({
        source: "compiled source"
      } as Awaited<ReturnType<typeof compile>>);
      const registrySpy = vi
        .spyOn(integrationHelpers, "processDefineRulesPresetRegistryFile")
        .mockResolvedValue(
          createRegistryResult(createV4PresetBuildSource("short_class"))
        );

      const harness = createBuildHarness({ minify: true });
      await loadExtractedCssFromEntry(harness);

      expect(registrySpy).toHaveBeenCalledWith({
        source: "compiled source",
        filePath: "/workspace/src/extracted_rules.css.ts",
        outputCss: undefined,
        identOption: "short"
      });
    });

    it("serializes supported fixture matrix cases through the esbuild extracted-css registry path", async () => {
      for (const fixtureCase of serializedRegistryFixtureCases) {
        if (fixtureCase.caseId === "registry-imported-helper-executed") {
          continue;
        }

        vi.restoreAllMocks();

        const fixtureSource = readFixtureSource(fixtureCase.fixturePath);
        for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
          expectSourceToContainSnippet(fixtureSource, expectedSourceSnippet);
        }

        vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
          code: 'import "extracted_rules.css.ts";\nexport { css, preset, shared };',
          result: ["extracted_rules.css.ts", "resolver contents"]
        });
        const compileFixtureSource = integrationHelpers.compile;
        vi.spyOn(integrationHelpers, "compile").mockImplementation(
          (options: Parameters<typeof compile>[0]) =>
            compileFixtureSource({
              ...options,
              contents: fixtureSource
            })
        );
        const registrySpy = vi.spyOn(
          integrationHelpers,
          "processDefineRulesPresetRegistryFile"
        );

        const realEsbuild = await import("esbuild");
        const harness = createBuildHarness({
          absWorkingDir: process.cwd(),
          esbuild: realEsbuild
        });
        const { loadResult, resolveResult } = await loadExtractedCssFromEntry(
          harness,
          join(process.cwd(), "packages/esbuild/src/app.ts")
        );

        expect(registrySpy).toHaveBeenCalledWith({
          source: expect.any(String),
          filePath: resolveResult.path,
          outputCss: undefined,
          identOption: "debug"
        });
        expect(registrySpy).toHaveBeenCalledTimes(1);
        expect(loadResult.loader).toBe("js");
        expect(loadResult.resolveDir).toBe(dirname(resolveResult.path));
        expectSourceToContainV4PresetArtifact(loadResult.contents);
        expectSourceToContainPopulatedClassNameByCache(loadResult.contents);
      }
    });

    it("skips function-valued config fixture registry artifacts through the esbuild registry path", async () => {
      const fixtureCase = registryFixtureMatrixCases.find(
        (candidate) => candidate.caseId === "registry-function-config-invalid"
      );
      if (fixtureCase == null) {
        throw new Error("Missing registry function config fixture case");
      }

      const fixtureSource = readFixtureSource(fixtureCase.fixturePath);
      for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
        expectSourceToContainSnippet(fixtureSource, expectedSourceSnippet);
      }

      vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { raw };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      const compileFixtureSource = integrationHelpers.compile;
      vi.spyOn(integrationHelpers, "compile").mockImplementation(
        (options: Parameters<typeof compile>[0]) =>
          compileFixtureSource({
            ...options,
            filePath: fixtureCase.fixturePath,
            originalPath: fixtureCase.fixturePath,
            contents: fixtureSource
          })
      );
      const registrySpy = vi.spyOn(
        integrationHelpers,
        "processDefineRulesPresetRegistryFile"
      );

      const realEsbuild = await import("esbuild");
      const harness = createBuildHarness({
        absWorkingDir: process.cwd(),
        esbuild: realEsbuild
      });
      const scriptLoadResult = (await harness.loadScript({
        path: join(process.cwd(), "packages/esbuild/src/app.ts")
      })) as ScriptLoadResult;
      const resolveResult = (await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: join(process.cwd(), "packages/esbuild/src/app.ts"),
        pluginData: scriptLoadResult.pluginData
      })) as ResolvedExtractedCssResult;
      const loadResult = (await harness.loadExtractedCss({
        path: resolveResult.path,
        pluginData: resolveResult.pluginData
      })) as ExtractedCssLoadResult;

      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(loadResult.loader).toBe("js");
      expect(countV4PresetArtifacts(loadResult.contents)).toBe(0);
      expect(loadResult.contents).toContain("rebeccapurple");
    }, 20000);

    it("keeps root css alias reuse paired with the explicit css asset import when no local extraction is needed", async () => {
      const consumerFixtureSource = readFixtureSource(
        consumerFixturePath
      ).replaceAll(
        "__DEFINE_RULES_PRESET_SPECIFIER__",
        "@mincho-js-proof/define-rules-preset"
      );

      vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
        code: consumerFixtureSource,
        result: ["extracted_rules.css.ts", ""]
      });

      const harness = createBuildHarness();
      const loadResult = (await harness.loadScript({
        path: "/workspace/src/app.ts"
      })) as {
        contents: string;
        loader: string;
        pluginData: {
          mainFilePath: string;
        };
      };
      const resolveResult = await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: "/workspace/src/app.ts",
        pluginData: loadResult.pluginData
      });

      expect(loadResult.contents).toBe(consumerFixtureSource);
      expect(loadResult.loader).toBe("ts");
      expect(resolveResult).toBeUndefined();
      expect(loadResult.contents).toContain(
        'import "@mincho-js-proof/define-rules-preset/shared-component.css";'
      );
      expect(loadResult.contents).toContain(
        '} from "@mincho-js-proof/define-rules-preset";'
      );
      expect(loadResult.contents).toContain("  css,");
      expect(loadResult.contents).toContain("export { importedShared };");
    });

    it("preserves the existing ReferenceError wrapping when extracted css evaluation fails", async () => {
      vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
        code: "export const app = {};",
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationHelpers, "compile").mockResolvedValue({
        source: "compiled source"
      } as Awaited<ReturnType<typeof compile>>);
      const registrySpy = vi
        .spyOn(integrationHelpers, "processDefineRulesPresetRegistryFile")
        .mockRejectedValue(new ReferenceError("window is not defined"));

      const harness = createBuildHarness();
      const scriptLoadResult = (await harness.loadScript({
        path: "/workspace/src/app.ts"
      })) as ScriptLoadResult;
      const resolveResult = (await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: "/workspace/src/app.ts",
        pluginData: scriptLoadResult.pluginData
      })) as ResolvedExtractedCssResult;
      const loadResult = (await harness.loadExtractedCss({
        path: resolveResult.path,
        pluginData: resolveResult.pluginData
      })) as {
        errors: Array<{
          text: string;
          detail: string;
        }>;
      };

      expect(registrySpy).toHaveBeenCalledWith({
        source: "compiled source",
        filePath: "/workspace/src/extracted_rules.css.ts",
        outputCss: undefined,
        identOption: "debug"
      });
      expect(loadResult).toEqual({
        errors: [
          {
            text: "ReferenceError: window is not defined",
            detail:
              "This usually happens if you use a browser api at the top level of a file being imported."
          }
        ]
      });
    });

    it("cleans extracted-css resolvers on build end", async () => {
      vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport const app = {};',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });

      const harness = createBuildHarness();
      const scriptLoadResult = (await harness.loadScript({
        path: "/workspace/src/app.ts"
      })) as ScriptLoadResult;
      const resolveBeforeEnd = await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: "/workspace/src/app.ts",
        pluginData: scriptLoadResult.pluginData
      });

      harness.endBuild();

      const resolveAfterEnd = await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: "/workspace/src/app.ts",
        pluginData: scriptLoadResult.pluginData
      });

      expect(resolveBeforeEnd).toEqual({
        namespace: "extracted-css",
        path: "/workspace/src/extracted_rules.css.ts",
        pluginData: {
          path: "extracted_rules.css.ts",
          mainFilePath: "/workspace/src/app.ts"
        }
      });
      expect(resolveAfterEnd).toBeUndefined();
    });

    it("defineRules preset registry steps are queued so concurrent esbuild loads cannot overlap shared registry sessions", async () => {
      const firstDeferred = createDeferred<string>();
      const secondDeferred = createDeferred<string>();
      const processOrder: string[] = [];

      vi.spyOn(integrationHelpers, "babelTransform")
        .mockResolvedValueOnce({
          code: "export const appA = {};",
          result: ["extracted_a.css.ts", "resolver contents a"]
        })
        .mockResolvedValueOnce({
          code: "export const appB = {};",
          result: ["extracted_b.css.ts", "resolver contents b"]
        });
      vi.spyOn(integrationHelpers, "compile").mockImplementation(
        async (options: Parameters<typeof compile>[0]) =>
          ({
            source: `compiled source:${options.filePath}`
          }) as Awaited<ReturnType<typeof compile>>
      );
      const registrySpy = vi
        .spyOn(integrationHelpers, "processDefineRulesPresetRegistryFile")
        .mockImplementation(
          async (
            options: Parameters<typeof processDefineRulesPresetRegistryFile>[0]
          ) => {
            processOrder.push(`start:${options.filePath}`);

            if (options.filePath.endsWith("extracted_a.css.ts")) {
              const result = await firstDeferred.promise;
              processOrder.push(`end:${options.filePath}`);
              return createRegistryResult(result);
            }

            const result = await secondDeferred.promise;
            processOrder.push(`end:${options.filePath}`);
            return createRegistryResult(result);
          }
        );

      const harness = createBuildHarness();
      const scriptLoadResultA = (await harness.loadScript({
        path: "/workspace/src/app-a.ts"
      })) as ScriptLoadResult;
      const scriptLoadResultB = (await harness.loadScript({
        path: "/workspace/src/app-b.ts"
      })) as ScriptLoadResult;
      const resolveResultA = (await harness.resolveExtractedCss({
        path: "extracted_a.css.ts",
        importer: "/workspace/src/app-a.ts",
        pluginData: scriptLoadResultA.pluginData
      })) as ResolvedExtractedCssResult;
      const resolveResultB = (await harness.resolveExtractedCss({
        path: "extracted_b.css.ts",
        importer: "/workspace/src/app-b.ts",
        pluginData: scriptLoadResultB.pluginData
      })) as ResolvedExtractedCssResult;

      const firstLoadPromise = harness.loadExtractedCss({
        path: resolveResultA.path,
        pluginData: resolveResultA.pluginData
      }) as Promise<ExtractedCssLoadResult>;
      const secondLoadPromise = harness.loadExtractedCss({
        path: resolveResultB.path,
        pluginData: resolveResultB.pluginData
      }) as Promise<ExtractedCssLoadResult>;

      await vi.waitFor(() => {
        expect(processOrder).toEqual([
          "start:/workspace/src/extracted_a.css.ts"
        ]);
      });

      firstDeferred.resolve(createV4PresetBuildSource("provider-a_class"));
      const firstLoadResult = await firstLoadPromise;

      await vi.waitFor(() => {
        expect(processOrder).toEqual([
          "start:/workspace/src/extracted_a.css.ts",
          "end:/workspace/src/extracted_a.css.ts",
          "start:/workspace/src/extracted_b.css.ts"
        ]);
      });

      secondDeferred.resolve(createV4PresetBuildSource("provider-b_class"));
      const secondLoadResult = await secondLoadPromise;

      expect(processOrder).toEqual([
        "start:/workspace/src/extracted_a.css.ts",
        "end:/workspace/src/extracted_a.css.ts",
        "start:/workspace/src/extracted_b.css.ts",
        "end:/workspace/src/extracted_b.css.ts"
      ]);
      expect(registrySpy).toHaveBeenNthCalledWith(1, {
        source: "compiled source:/workspace/src/extracted_a.css.ts",
        filePath: "/workspace/src/extracted_a.css.ts",
        outputCss: undefined,
        identOption: "debug"
      });
      expect(registrySpy).toHaveBeenNthCalledWith(2, {
        source: "compiled source:/workspace/src/extracted_b.css.ts",
        filePath: "/workspace/src/extracted_b.css.ts",
        outputCss: undefined,
        identOption: "debug"
      });
      expectSourceToContainClassNameByCacheValue(
        firstLoadResult.contents,
        "provider-a_class"
      );
      expectSourceToContainClassNameByCacheValue(
        secondLoadResult.contents,
        "provider-b_class"
      );
      expect(firstLoadResult.contents).not.toContain("provider-b_class");
      expect(secondLoadResult.contents).not.toContain("provider-a_class");
    });
  });
}
