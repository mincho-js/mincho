import {
  type BabelOptions,
  babelTransform,
  compile,
  processDefineRulesPresetRegistryFile,
  runDefineRulesPresetRegistryStep
} from "@mincho-js/integration";
import { processVanillaFile } from "@vanilla-extract/integration";
import { normalizePath } from "@rollup/pluginutils";
import { join, resolve } from "node:path";
import * as fs from "node:fs";

interface Module {
  lastHMRTimestamp?: number;
  lastInvalidationTimestamp?: number;
}

// Define local interfaces instead of importing directly from Vite
interface ViteDevServer {
  moduleGraph: {
    getModuleById: (id: string) => Module;
    invalidateModule: (module: Module) => void;
  };
}

interface ResolvedConfig {
  root: string;
  command: string;
  mode: string;
  build: {
    watch: boolean;
  };
}

interface PluginContext {
  addWatchFile: (id: string) => void;
}

// Simplified Plugin interface with only what we need
interface Plugin {
  name: string;
  enforce?: string;
  buildStart?: () => void;
  configureServer?: (server: ViteDevServer) => void;
  configResolved?: (config: ResolvedConfig) => void | Promise<void>;
  resolveId?: (id: string, importer?: string) => string | undefined;
  load?: (id: string) => unknown | Promise<unknown>;
  transform?: (code: string, id: string) => unknown | Promise<unknown>;
}

// Alias for Plugin to match PluginOption
type PluginOption = Plugin;

// Match both the old format and the new virtual format
function extractedCssFileFilter(filePath: string) {
  const extractedIndex = filePath.indexOf("extracted_");
  if (extractedIndex === -1) {
    return false;
  }

  const afterExtracted = filePath.substring(extractedIndex);
  if (afterExtracted.includes("/")) {
    return false;
  }

  if (
    !(
      afterExtracted.endsWith(".css.ts") ||
      afterExtracted.endsWith(".css.ts?used")
    )
  ) {
    return false;
  }

  return true;
}

export function minchoVitePlugin(_options?: {
  babel?: BabelOptions;
}): PluginOption {
  let config: ResolvedConfig;
  let server: ViteDevServer;
  const cssMap = new Map<string, string>();
  const resolverCache = new Map<string, string>();
  const resolvers = new Map<string, string>();
  const idToPluginData = new Map<string, Record<string, string>>();
  const virtualExt = ".vanilla.css";

  return {
    name: "mincho-css-vite",
    enforce: "pre",
    buildStart() {
      // resolvers.clear();
      // resolverCache.clear();
      // cssMap.clear();
      // idToPluginData.clear();
    },
    configureServer(serverInstance: ViteDevServer) {
      server = serverInstance;
    },
    async configResolved(resolvedConfig: ResolvedConfig) {
      config = resolvedConfig;
    },
    resolveId(id: string, importer?: string) {
      if (id.startsWith("\0")) return;

      if (extractedCssFileFilter(id)) {
        const normalizedId = id.startsWith("/") ? id.slice(1) : id;
        const resolvedPath = normalizePath(join(importer!, "..", normalizedId));

        if (!resolvers.has(resolvedPath)) {
          return;
        }
        return resolvedPath;
      }

      if (id.endsWith(virtualExt)) {
        const normalizedId = id.startsWith("/") ? id.slice(1) : id;

        const key = normalizePath(resolve(config.root, normalizedId));
        if (cssMap.has(key)) {
          return key;
        }
      }
    },
    async load(
      id: string
    ): Promise<string | null | { code: string; map?: object | null }> {
      if (id.startsWith("\0")) {
        return null;
      }

      // Handle both old and new CSS file formats
      if (extractedCssFileFilter(id)) {
        const normalizedId = customNormalize(id);
        const pluginData = idToPluginData.get(normalizedId);

        if (!pluginData) {
          return null;
        }

        const resolverContents = resolvers.get(pluginData.path);

        if (!resolverContents) {
          return null;
        }

        idToPluginData.set(id, {
          ...idToPluginData.get(id),
          filePath: id,
          originalPath: pluginData.mainFilePath
        });

        return resolverContents;
      }

      if (id.endsWith(virtualExt)) {
        const cssFileId = normalizePath(resolve(config.root, id));
        const css = cssMap.get(cssFileId);

        if (typeof css !== "string") {
          return null;
        }

        return css;
      }
      return null;
    },
    async transform(this: PluginContext, code: string, id: string) {
      if (id.startsWith("\0")) return;

      const moduleInfo = idToPluginData.get(id);

      // Handle both old and new CSS file formats for transformation
      if (
        moduleInfo &&
        moduleInfo.originalPath &&
        moduleInfo.filePath &&
        extractedCssFileFilter(id)
      ) {
        try {
          const { source, watchFiles } = await compile({
            filePath: moduleInfo.filePath,
            cwd: config.root,
            originalPath: moduleInfo.originalPath,
            contents: code,
            resolverCache,
            externals: []
          });

          for (const file of watchFiles) {
            if (extractedCssFileFilter(file)) {
              continue;
            }

            // In start mode, we need to prevent the file from rewatching itself.
            // If it's a `build --watch`, it needs to watch everything.
            if (config.command === "build" || file !== id) {
              this.addWatchFile(file);
            }
          }

          const processVanillaFileOptions = {
            source,
            filePath: moduleInfo.filePath,
            identOption: config.mode === "production" ? "short" : "debug",
            serializeVirtualCssPath: async ({ fileScope, source }) => {
              const id: string = `${fileScope.filePath}${virtualExt}`;
              const cssFileId = normalizePath(resolve(config.root, id));

              if (server) {
                const { moduleGraph } = server;
                const moduleId = normalizePath(join(config.root, id));
                const module = moduleGraph.getModuleById(moduleId);

                if (module) {
                  moduleGraph.invalidateModule(module);
                  module.lastHMRTimestamp =
                    module.lastInvalidationTimestamp || Date.now();
                }
              }

              cssMap.set(cssFileId, source);

              return `import "${id}";`;
            }
          } satisfies Parameters<typeof processVanillaFile>[0];

          const contents =
            config.command === "build"
              ? await runDefineRulesPresetRegistryStep(async () => {
                  const { source } = await processDefineRulesPresetRegistryFile(
                    processVanillaFileOptions
                  );

                  return source;
                })
              : await processVanillaFile(processVanillaFileOptions);

          return contents;
        } catch (error) {
          if (config.command === "build") {
            throw error;
          }

          console.error(error);
        }
      }

      if (/(j|t)sx?(\?used)?$/.test(id) && !id.endsWith(".vanilla.js")) {
        if (id.includes("node_modules")) return;

        if (id.endsWith(".css.ts")) return;

        try {
          await fs.promises.access(id, fs.constants.F_OK);
        } catch {
          return;
        }

        const {
          code,
          result: [file, cssExtract]
        } = await babelTransform(id, _options?.babel);

        if (!cssExtract || !file) return null;

        if (config.command === "build" && config.build.watch) {
          this.addWatchFile(file);
        }

        const resolvedCssPath = normalizePath(join(id, "..", file));

        if (server && resolvers.has(resolvedCssPath)) {
          const { moduleGraph } = server;

          const module = moduleGraph.getModuleById(resolvedCssPath);
          if (module) {
            moduleGraph.invalidateModule(module);
          }
        }

        const normalizedCssPath = customNormalize(resolvedCssPath);

        resolvers.set(resolvedCssPath, cssExtract);
        resolverCache.delete(id);
        idToPluginData.delete(id);
        idToPluginData.delete(normalizedCssPath);

        idToPluginData.set(id, {
          ...idToPluginData.get(id),
          mainFilePath: id
        });
        idToPluginData.set(normalizedCssPath, {
          ...idToPluginData.get(normalizedCssPath),
          mainFilePath: id,
          path: resolvedCssPath
        });

        return {
          code,
          map: { mappings: "" }
        };
      }
      return null;
    }
  } as PluginOption;
}

function customNormalize(path: string) {
  return path.startsWith("/") ? path.slice(1) : path;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { afterEach, beforeAll, describe, expect, it, vi } = import.meta.vitest;

  const DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX =
    "__MINCHO_DEFINE_RULES_SENTINEL__:";
  const DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR =
    "defineRules preset backfill mismatch";
  const DEFINE_RULES_FUNCTION_CONFIG_DIAGNOSTIC =
    "defineRules serialized css does not support function-valued properties or shortcuts";
  const explicitProviderSidecarImport =
    'import "@mincho-js-proof/define-rules-preset/shared-component.css";';
  type DefineRulesPresetSerializationCase = {
    caseId: string;
    expectedSourceSnippets: readonly string[];
    relativePath: string;
  };

  type DefineRulesPresetSerializationFixtureCase =
    DefineRulesPresetSerializationCase & {
      fixturePath: string;
    };

  type DefineRulesPresetSerializationPaths = {
    providerDistModule: string;
    providerRoot: string;
    providerSidecarCss: string;
    viteConsumerEntry: string;
    viteConsumerRoot: string;
  };

  type DefineRulesPresetSerializationManifest = {
    DEFINE_RULES_PRESET_SERIALIZATION_PATHS: DefineRulesPresetSerializationPaths;
    DEFINE_RULES_PRESET_SERIALIZATION_SUPPORTED_MATRIX_CASES: readonly DefineRulesPresetSerializationCase[];
    DEFINE_RULES_PRESET_SERIALIZATION_UNSUPPORTED_MATRIX_CASES: readonly DefineRulesPresetSerializationCase[];
    createDefineRulesPresetSerializationFixturePath: (
      relativePath: string
    ) => string;
  };

  let providerDistModulePath: string;
  let providerRootFixturePath: string;
  let providerSidecarCssPath: string;
  let supportedFixtureMatrixCases: DefineRulesPresetSerializationFixtureCase[] =
    [];
  let unsupportedFixtureMatrixCases: DefineRulesPresetSerializationFixtureCase[] =
    [];
  let viteConsumerEntryPath: string;
  let viteConsumerRootPath: string;

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
      DEFINE_RULES_PRESET_SERIALIZATION_SUPPORTED_MATRIX_CASES,
      DEFINE_RULES_PRESET_SERIALIZATION_UNSUPPORTED_MATRIX_CASES,
      createDefineRulesPresetSerializationFixturePath
    } = manifest;

    viteConsumerRootPath = createDefineRulesPresetSerializationFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.viteConsumerRoot
    );
    viteConsumerEntryPath = createDefineRulesPresetSerializationFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.viteConsumerEntry
    );
    providerRootFixturePath = createDefineRulesPresetSerializationFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.providerRoot
    );
    providerDistModulePath = createDefineRulesPresetSerializationFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.providerDistModule
    );
    providerSidecarCssPath = createDefineRulesPresetSerializationFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.providerSidecarCss
    );
    supportedFixtureMatrixCases = createFixtureMatrixCases(
      DEFINE_RULES_PRESET_SERIALIZATION_SUPPORTED_MATRIX_CASES,
      createDefineRulesPresetSerializationFixturePath
    );
    unsupportedFixtureMatrixCases = createFixtureMatrixCases(
      DEFINE_RULES_PRESET_SERIALIZATION_UNSUPPORTED_MATRIX_CASES,
      createDefineRulesPresetSerializationFixturePath
    );
  }

  beforeAll(async () => {
    initializeDefineRulesPresetSerializationFixtures(
      await loadDefineRulesPresetSerializationManifest()
    );
  });

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

  function injectDefineRulesPresetSentinel(
    source: string,
    sentinelId: string
  ): string {
    const callStart = source.indexOf("defineRules(");
    if (callStart === -1) {
      throw new Error(
        "Failed to locate a fixture defineRules call for sentinel injection"
      );
    }

    const openParenIndex = source.indexOf("(", callStart);
    if (openParenIndex === -1) {
      throw new Error(
        "Failed to locate the opening parenthesis for a fixture defineRules call"
      );
    }

    let depth = 0;
    let closingParenIndex = -1;
    let activeQuote: '"' | "'" | "`" | undefined;
    let escaped = false;

    for (let index = openParenIndex; index < source.length; index += 1) {
      const character = source[index];
      if (character == null) {
        continue;
      }

      if (activeQuote != null) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (character === "\\") {
          escaped = true;
          continue;
        }

        if (character === activeQuote) {
          activeQuote = undefined;
        }

        continue;
      }

      if (character === '"' || character === "'" || character === "`") {
        activeQuote = character;
        continue;
      }

      if (character === "(") {
        depth += 1;
        continue;
      }

      if (character !== ")") {
        continue;
      }

      depth -= 1;
      if (depth === 0) {
        closingParenIndex = index;
        break;
      }
    }

    if (closingParenIndex === -1) {
      throw new Error(
        "Failed to locate the closing parenthesis for a fixture defineRules call"
      );
    }

    return `${source.slice(0, closingParenIndex)}, "${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}${sentinelId}"${source.slice(closingParenIndex)}`;
  }

  function createFixtureBuildSource(
    filePath: string,
    sentinelId: string
  ): string {
    return injectDefineRulesPresetSentinel(
      readFixtureSource(filePath),
      sentinelId
    );
  }

  function createLivePresetSmokeEntrySource(): string {
    return `
      import { css, defineRules } from "@mincho-js/css";

      const presetOwner = defineRules({
        debugId: "vite-build-smoke",
        properties: {
          background: true
        }
      });
      export const fillBlue = css(
        presetOwner.css.raw({ background: "blue" })
      );
    `;
  }

  async function createLivePresetSmokeFixture(prefix: string) {
    const cacheRoot = join(process.cwd(), "packages/vite/.cache");
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

  function extractFillBlueClassName(source: string): string {
    const match = source.match(/fillBlue\s*=\s*["']([^"']+)["']/);
    if (match?.[1] == null) {
      throw new Error(
        "Expected build output to include a fillBlue class literal"
      );
    }

    return match[1];
  }

  function createPresetCaptureSession(
    filePath: string,
    sentinelId: string,
    presetMap: Record<string, string>
  ) {
    return {
      filePath,
      instances: [
        {
          sentinelId,
          filePath,
          instanceIndex: 0,
          getPresetSnapshot: () => presetMap
        }
      ]
    };
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

  function createResolvedConfig(
    overrides: Partial<ResolvedConfig> = {}
  ): ResolvedConfig {
    const { build: buildOverrides, ...restOverrides } = overrides;

    return {
      root: viteConsumerRootPath,
      command: "build",
      mode: "production",
      ...restOverrides,
      build: {
        watch: buildOverrides?.watch ?? false
      }
    };
  }

  async function createViteHarness({
    configOverrides,
    server
  }: {
    configOverrides?: Partial<ResolvedConfig>;
    server?: ViteDevServer;
  } = {}) {
    const plugin = minchoVitePlugin();

    await plugin.configResolved?.(createResolvedConfig(configOverrides));
    if (server) {
      plugin.configureServer?.(server);
    }

    return {
      async load(id: string) {
        return plugin.load?.(id);
      },
      resolveId(id: string, importer?: string) {
        return plugin.resolveId?.(id, importer);
      },
      async transform(id: string, code: string) {
        return plugin.transform?.call(
          {
            addWatchFile() {}
          },
          code,
          id
        );
      }
    };
  }

  async function createExtractedCssFixture(
    harness: Awaited<ReturnType<typeof createViteHarness>>
  ) {
    return createExtractedCssFixtureFromEntry(harness, viteConsumerEntryPath);
  }

  async function createExtractedCssFixtureFromEntry(
    harness: Awaited<ReturnType<typeof createViteHarness>>,
    entryPath: string
  ) {
    const entrySource = await fs.promises.readFile(entryPath, "utf8");
    const transformedEntry = await harness.transform(entryPath, entrySource);

    if (
      transformedEntry == null ||
      typeof transformedEntry !== "object" ||
      !("code" in transformedEntry) ||
      typeof transformedEntry.code !== "string"
    ) {
      throw new Error("Expected the entry transform to return code");
    }

    const extractedImportMatch = transformedEntry.code.match(
      /import\s+["']([^"']*extracted_[^"']+\.css\.ts)["'];?/
    );
    if (extractedImportMatch == null) {
      throw new Error("Failed to locate the extracted css import");
    }

    const extractedId = harness.resolveId(extractedImportMatch[1], entryPath);
    if (typeof extractedId !== "string") {
      throw new Error("Expected the extracted css id to resolve");
    }

    const extractedSource = await harness.load(extractedId);
    if (typeof extractedSource !== "string") {
      throw new Error(
        "Expected the extracted css module to load as source text"
      );
    }

    return {
      extractedId,
      extractedSource
    };
  }

  function createSentinelBuildSource(sentinelId: string): string {
    return `
      import { defineRules } from "@mincho-js/css";

      export const preset = defineRules(
        {
          properties: {
            color: true,
            display: true
          }
        },
        "${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}${sentinelId}"
      );
    `;
  }

  function extractPresetMapFromBuildSource(
    source: string
  ): Record<string, string> {
    const presetMapMatch = source.match(
      /["']?presets["']?\s*:\s*(\{[\s\S]*?\})(?=\s*[,}])/
    );

    if (presetMapMatch?.[1] == null) {
      throw new Error(
        "Failed to locate a raw preset map in the rewritten build output"
      );
    }

    const presetMap: Record<string, string> = {};

    for (const presetEntryMatch of presetMapMatch[1].matchAll(
      /(?:(["'])([^"']+)\1|([A-Za-z_$][\w$]*))\s*:\s*(["'])(.*?)\4/g
    )) {
      const key = presetEntryMatch[2] ?? presetEntryMatch[3];
      const value = presetEntryMatch[5];

      if (key == null || value == null) {
        continue;
      }

      presetMap[key] = value;
    }

    if (Object.keys(presetMap).length === 0) {
      throw new Error(
        "Failed to parse a serialized preset map from rewritten build output"
      );
    }

    return presetMap;
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractExportedVariableInitializerFromBuildSource(
    source: string,
    exportName: string
  ): string {
    const exportMatch = source.match(
      new RegExp(
        `export\\s+(?:const|let|var)\\s+${escapeRegExp(exportName)}\\s*=\\s*([^;]+);`
      )
    );

    if (exportMatch?.[1] == null) {
      throw new Error(`Failed to locate exported variable ${exportName}`);
    }

    return exportMatch[1].trim();
  }

  function extractExportedStringValueFromBuildSource(
    source: string,
    exportName: string
  ): string {
    const initializer = extractExportedVariableInitializerFromBuildSource(
      source,
      exportName
    );
    const stringLiteralMatch = initializer.match(/^(["'])(.*)\1$/);

    if (stringLiteralMatch?.[2] == null) {
      throw new Error(`Expected export ${exportName} to be a string literal`);
    }

    return stringLiteralMatch[2];
  }

  function extractVariableStringValueFromBuildSource(
    source: string,
    variableName: string
  ): string {
    const variableMatch = source.match(
      new RegExp(
        `\\b(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(variableName)}\\s*=\\s*(["'])(.*?)\\1\\s*;`
      )
    );

    if (variableMatch?.[2] == null) {
      throw new Error(
        `Expected variable ${variableName} to be a string literal`
      );
    }

    return variableMatch[2];
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

  function assertString(
    value: unknown,
    message: string
  ): asserts value is string {
    if (typeof value !== "string") {
      throw new Error(message);
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("minchoVitePlugin", () => {
    it.skip("defineRules preset capture sessions are queued in Vite builds", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const vanillaExtractIntegration =
        await import("@vanilla-extract/integration");
      const firstDeferred = createDeferred<string>();
      const secondDeferred = createDeferred<string>();
      const processOrder: string[] = [];
      const captureSessions = new Map<
        string,
        ReturnType<typeof createPresetCaptureSession>
      >();

      vi.spyOn(integrationModule, "babelTransform")
        .mockResolvedValueOnce({
          code: 'import "extracted_a.css.ts";\nexport { cssA };',
          result: ["extracted_a.css.ts", "resolver contents a"]
        })
        .mockResolvedValueOnce({
          code: 'import "extracted_b.css.ts";\nexport { cssB };',
          result: ["extracted_b.css.ts", "resolver contents b"]
        });
      vi.spyOn(integrationModule, "compile").mockImplementation(
        async (options: Parameters<typeof compile>[0]) =>
          ({
            source: `compiled source:${options.filePath}`,
            watchFiles: []
          }) as Awaited<ReturnType<typeof compile>>
      );
      vi.spyOn(
        integrationModule,
        "captureDefineRulesPresetSession"
      ).mockImplementation(
        async (filePath: string, evaluate: () => Promise<string>) => {
          const result = await evaluate();
          const sentinelId = filePath.endsWith("extracted_a.css.ts")
            ? "provider-a"
            : "provider-b";
          const captureSession = createPresetCaptureSession(
            filePath,
            sentinelId,
            {
              [sentinelId]: `${sentinelId}_class`
            }
          );
          captureSessions.set(filePath, captureSession);

          return {
            result,
            captureSession
          };
        }
      );
      const backfillSpy = vi.spyOn(
        integrationModule,
        "backfillDefineRulesPresetArtifacts"
      );
      vi.spyOn(
        vanillaExtractIntegration,
        "processVanillaFile"
      ).mockImplementation(
        async ({ filePath }: Parameters<typeof processVanillaFile>[0]) => {
          processOrder.push(`start:${filePath}`);

          if (filePath.endsWith("extracted_a.css.ts")) {
            const result = await firstDeferred.promise;
            processOrder.push(`end:${filePath}`);
            return result;
          }

          const result = await secondDeferred.promise;
          processOrder.push(`end:${filePath}`);
          return result;
        }
      );

      const harness = await createViteHarness();
      const firstFixture = await createExtractedCssFixture(harness);
      const secondFixture = await createExtractedCssFixture(harness);
      const firstTransformPromise = harness.transform(
        firstFixture.extractedId,
        firstFixture.extractedSource
      ) as Promise<string>;
      const secondTransformPromise = harness.transform(
        secondFixture.extractedId,
        secondFixture.extractedSource
      ) as Promise<string>;

      await vi.waitFor(() => {
        expect(processOrder).toEqual([`start:${firstFixture.extractedId}`]);
      });

      firstDeferred.resolve(createSentinelBuildSource("provider-a"));
      const firstTransformResult = await firstTransformPromise;
      assertString(
        firstTransformResult,
        "Expected the first queued transform to return source text"
      );

      await vi.waitFor(() => {
        expect(processOrder).toEqual([
          `start:${firstFixture.extractedId}`,
          `end:${firstFixture.extractedId}`,
          `start:${secondFixture.extractedId}`
        ]);
      });

      secondDeferred.resolve(createSentinelBuildSource("provider-b"));
      const secondTransformResult = await secondTransformPromise;
      assertString(
        secondTransformResult,
        "Expected the second queued transform to return source text"
      );

      expect(processOrder).toEqual([
        `start:${firstFixture.extractedId}`,
        `end:${firstFixture.extractedId}`,
        `start:${secondFixture.extractedId}`,
        `end:${secondFixture.extractedId}`
      ]);
      expect(backfillSpy).toHaveBeenNthCalledWith(
        1,
        [
          {
            filePath: firstFixture.extractedId,
            source: expect.stringContaining("provider-a")
          }
        ],
        captureSessions.get(firstFixture.extractedId)
      );
      expect(backfillSpy).toHaveBeenNthCalledWith(
        2,
        [
          {
            filePath: secondFixture.extractedId,
            source: expect.stringContaining("provider-b")
          }
        ],
        captureSessions.get(secondFixture.extractedId)
      );
      expect(extractPresetMapFromBuildSource(firstTransformResult)).toEqual({
        "provider-a": "provider-a_class"
      });
      expect(extractPresetMapFromBuildSource(secondTransformResult)).toEqual({
        "provider-b": "provider-b_class"
      });
      expect(firstTransformResult).not.toContain("provider-b_class");
      expect(secondTransformResult).not.toContain("provider-a_class");
    });

    it.skip("backfills build output preset maps and strips sentinel args", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const vanillaExtractIntegration =
        await import("@vanilla-extract/integration");
      let captureSession:
        | ReturnType<typeof createPresetCaptureSession>
        | undefined;

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css, shared };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      } as Awaited<ReturnType<typeof compile>>);
      vi.spyOn(
        integrationModule,
        "captureDefineRulesPresetSession"
      ).mockImplementation(
        async (filePath: string, evaluate: () => Promise<string>) => {
          const nextCaptureSession = createPresetCaptureSession(
            filePath,
            "provider",
            {
              shared: "shared_class"
            }
          );
          captureSession = nextCaptureSession;

          return {
            result: await evaluate(),
            captureSession: nextCaptureSession
          };
        }
      );
      const backfillSpy = vi.spyOn(
        integrationModule,
        "backfillDefineRulesPresetArtifacts"
      );
      vi.spyOn(
        vanillaExtractIntegration,
        "processVanillaFile"
      ).mockResolvedValue(createSentinelBuildSource("provider"));

      const harness = await createViteHarness();
      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);
      const transformedExtractedCss = await harness.transform(
        extractedId,
        extractedSource
      );
      assertString(
        transformedExtractedCss,
        "Expected extracted css transform to return source text"
      );
      if (captureSession == null) {
        throw new Error("Expected defineRules preset capture session");
      }

      expect(backfillSpy).toHaveBeenCalledWith(
        [
          {
            filePath: extractedId,
            source: expect.stringContaining(
              `${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}provider`
            )
          }
        ],
        captureSession
      );
      expect(backfillSpy).toHaveBeenCalledTimes(1);
      expect(extractPresetMapFromBuildSource(transformedExtractedCss)).toEqual({
        shared: "shared_class"
      });
      expect(transformedExtractedCss).toContain("presets");
      expect(transformedExtractedCss).not.toContain(
        DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX
      );
    });

    it("builds a real Vite fixture with defineRules preset backfill", async () => {
      const { build } = await import("vite");
      const { entryPath, root } = await createLivePresetSmokeFixture(
        "define-rules-vite-smoke-"
      );

      try {
        const buildResult = await build({
          root,
          configFile: false,
          logLevel: "silent",
          plugins: [minchoVitePlugin() as never],
          build: {
            cssMinify: false,
            emptyOutDir: false,
            lib: {
              entry: entryPath,
              fileName: "index",
              formats: ["es"]
            },
            minify: false,
            write: false
          },
          resolve: {
            preserveSymlinks: true
          }
        });
        type ViteSmokeOutput =
          | { code: string; fileName: string; type: "chunk" }
          | { fileName: string; source: string | Uint8Array; type: "asset" };
        const rollupOutputs = Array.isArray(buildResult)
          ? buildResult
          : [buildResult];
        const outputFiles = rollupOutputs.flatMap((rollupOutput) => {
          const possibleRollupOutput = rollupOutput as { output?: unknown };
          if (!Array.isArray(possibleRollupOutput.output)) {
            throw new Error(
              "Expected Vite smoke build to return Rollup output"
            );
          }

          return possibleRollupOutput.output as ViteSmokeOutput[];
        });
        const jsOutput = outputFiles.find(
          (output) =>
            output.type === "chunk" && /\.(?:mjs|js)$/.test(output.fileName)
        );
        const cssOutput = outputFiles.find(
          (output) =>
            output.type === "asset" && output.fileName.endsWith(".css")
        );

        if (jsOutput?.type !== "chunk") {
          throw new Error("Expected Vite smoke build to emit an ES chunk");
        }
        if (
          cssOutput?.type !== "asset" ||
          typeof cssOutput.source !== "string"
        ) {
          throw new Error("Expected Vite smoke build to emit a CSS asset");
        }

        const fillBlueClassName = extractFillBlueClassName(jsOutput.code);
        expect(jsOutput.code).toContain("presets");
        expect(jsOutput.code).not.toMatch(
          new RegExp(
            `${escapeRegExp(DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX)}[^"']+`
          )
        );
        expect(jsOutput.code).not.toContain('background: "blue"');
        expect(cssOutput.source).toContain(`.${fillBlueClassName}`);
        expect(cssOutput.source).toContain("background: blue;");
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    });

    it("serializes live preset output through the Vite build artifact path", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const livePresetBuildSource = `
        import { defineRules } from "@mincho-js/css";

        export const { css } = defineRules({ properties: { background: true } });
        export const fillBlue = css({ background: "blue" });
      `;

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css, fillBlue };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      const compileFixtureSource: typeof compile = integrationModule.compile;
      const compileLivePresetFixture: typeof compile = (options) =>
        compileFixtureSource({
          ...options,
          contents: livePresetBuildSource
        });
      vi.spyOn(integrationModule, "compile").mockImplementation(
        compileLivePresetFixture
      );
      const registryFileSpy = vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      );

      const harness = await createViteHarness();
      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);
      const transformedExtractedCss = await harness.transform(
        extractedId,
        extractedSource
      );
      assertString(
        transformedExtractedCss,
        "Expected extracted css transform to return source text"
      );

      const fillBlueClassName = extractExportedStringValueFromBuildSource(
        transformedExtractedCss,
        "fillBlue"
      );
      const fillBlueInitializer =
        extractExportedVariableInitializerFromBuildSource(
          transformedExtractedCss,
          "fillBlue"
        );
      const serializedPresetMap = extractPresetMapFromBuildSource(
        transformedExtractedCss
      );
      const serializedFillBlueEntry = Object.entries(serializedPresetMap).find(
        ([key, value]) =>
          key.startsWith("fragment_") === false && value === fillBlueClassName
      );

      expect(registryFileSpy).toHaveBeenCalledWith({
        source: expect.any(String),
        filePath: extractedId,
        identOption: "short",
        serializeVirtualCssPath: expect.any(Function)
      });
      expect(fillBlueClassName.split(/\s+/)).toHaveLength(1);
      expect(fillBlueInitializer).not.toMatch(/\bcss\s*\(/);
      expect(
        hasCssCallWithStringProperty(
          transformedExtractedCss,
          "background",
          "blue"
        )
      ).toBe(false);
      expect(serializedFillBlueEntry).toBeDefined();
    });

    it("defineRules exported css rejects function-valued config", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const functionValuedConfigBuildSource = `
        import { defineRules } from "@mincho-js/css";

        export const { css } = defineRules({
          properties: {
            color(value: "brand" | "neutral") {
              return value === "brand" ? "blue" : "gray";
            }
          }
        });
      `;

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      const compileFixtureSource: typeof compile = integrationModule.compile;
      vi.spyOn(integrationModule, "compile").mockImplementation(
        (options: Parameters<typeof compileFixtureSource>[0]) =>
          compileFixtureSource({
            ...options,
            contents: functionValuedConfigBuildSource
          })
      );
      const harness = await createViteHarness();
      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);

      await expect(
        harness.transform(extractedId, extractedSource)
      ).rejects.toThrow(DEFINE_RULES_FUNCTION_CONFIG_DIAGNOSTIC);
    });

    it.skip("bubbles the locked mismatch error from build-time preset backfill", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const vanillaExtractIntegration =
        await import("@vanilla-extract/integration");
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const captureSession = {
        filePath: "/virtual/extracted_rules.css.ts",
        instances: [
          {
            sentinelId: "provider",
            filePath: "/virtual/extracted_rules.css.ts",
            instanceIndex: 0,
            getPresetSnapshot: () => ({
              shared: "shared_class"
            })
          }
        ]
      };

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css, shared };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      } as Awaited<ReturnType<typeof compile>>);
      vi.spyOn(
        integrationModule,
        "captureDefineRulesPresetSession"
      ).mockImplementation(
        async (_filePath: string, evaluate: () => Promise<string>) => ({
          result: await evaluate(),
          captureSession
        })
      );
      vi.spyOn(
        vanillaExtractIntegration,
        "processVanillaFile"
      ).mockResolvedValue(createSentinelBuildSource("other"));

      const harness = await createViteHarness();
      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);

      await expect(
        harness.transform(extractedId, extractedSource)
      ).rejects.toThrow(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it.skip("backfills supported fixture matrix cases through the Vite extracted-css matrix path", async () => {
      for (const fixtureCase of supportedFixtureMatrixCases) {
        vi.restoreAllMocks();

        const fixtureSource = readFixtureSource(fixtureCase.fixturePath);
        for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
          expectSourceToContainSnippet(fixtureSource, expectedSourceSnippet);
        }

        const buildSource = createFixtureBuildSource(
          fixtureCase.fixturePath,
          fixtureCase.caseId
        );
        const presetMap = {
          [fixtureCase.caseId]: `${fixtureCase.caseId}_class`
        };
        const integrationModule = await import("@mincho-js/integration");
        const vanillaExtractIntegration =
          await import("@vanilla-extract/integration");
        let captureSession:
          | ReturnType<typeof createPresetCaptureSession>
          | undefined;

        vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
          code: 'import "extracted_rules.css.ts";\nexport { css, preset };',
          result: ["extracted_rules.css.ts", "resolver contents"]
        });
        vi.spyOn(integrationModule, "compile").mockResolvedValue({
          source: "compiled source",
          watchFiles: []
        } as Awaited<ReturnType<typeof compile>>);
        vi.spyOn(
          integrationModule,
          "captureDefineRulesPresetSession"
        ).mockImplementation(
          async (filePath: string, evaluate: () => Promise<string>) => {
            captureSession = createPresetCaptureSession(
              filePath,
              fixtureCase.caseId,
              presetMap
            );

            return {
              result: await evaluate(),
              captureSession
            };
          }
        );
        const backfillSpy = vi.spyOn(
          integrationModule,
          "backfillDefineRulesPresetArtifacts"
        );
        vi.spyOn(
          vanillaExtractIntegration,
          "processVanillaFile"
        ).mockResolvedValue(buildSource);

        const harness = await createViteHarness();
        const { extractedId, extractedSource } =
          await createExtractedCssFixture(harness);
        const transformedExtractedCss = await harness.transform(
          extractedId,
          extractedSource
        );
        assertString(
          transformedExtractedCss,
          "Expected extracted css transform to return source text"
        );

        expect(backfillSpy).toHaveBeenCalledWith(
          [
            {
              filePath: extractedId,
              source: expect.stringContaining(
                `${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}${fixtureCase.caseId}`
              )
            }
          ],
          captureSession
        );
        expect(backfillSpy).toHaveBeenCalledTimes(1);

        for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
          expectSourceToContainSnippet(
            transformedExtractedCss,
            expectedSourceSnippet
          );
        }

        expect(
          extractPresetMapFromBuildSource(transformedExtractedCss)
        ).toEqual(presetMap);
        expect(transformedExtractedCss).toContain("presets");
        expect(transformedExtractedCss).not.toContain(
          DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX
        );
      }
    });

    it.skip("keeps the locked mismatch boundary for unsupported fixture matrix cases through the Vite extracted-css path", async () => {
      for (const fixtureCase of unsupportedFixtureMatrixCases) {
        vi.restoreAllMocks();

        const fixtureSource = readFixtureSource(fixtureCase.fixturePath);
        for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
          expectSourceToContainSnippet(fixtureSource, expectedSourceSnippet);
        }

        const buildSource = createFixtureBuildSource(
          fixtureCase.fixturePath,
          fixtureCase.caseId
        );
        const integrationModule = await import("@mincho-js/integration");
        const vanillaExtractIntegration =
          await import("@vanilla-extract/integration");
        const consoleErrorSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});

        vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
          code: 'import "extracted_rules.css.ts";\nexport { css, preset };',
          result: ["extracted_rules.css.ts", "resolver contents"]
        });
        vi.spyOn(integrationModule, "compile").mockResolvedValue({
          source: "compiled source",
          watchFiles: []
        } as Awaited<ReturnType<typeof compile>>);
        vi.spyOn(
          integrationModule,
          "captureDefineRulesPresetSession"
        ).mockImplementation(
          async (filePath: string, evaluate: () => Promise<string>) => ({
            result: await evaluate(),
            captureSession: createPresetCaptureSession(
              filePath,
              fixtureCase.caseId,
              {
                [fixtureCase.caseId]: `${fixtureCase.caseId}_class`
              }
            )
          })
        );
        vi.spyOn(
          vanillaExtractIntegration,
          "processVanillaFile"
        ).mockResolvedValue(buildSource);

        const harness = await createViteHarness();
        const { extractedId, extractedSource } =
          await createExtractedCssFixture(harness);

        await expect(
          harness.transform(extractedId, extractedSource)
        ).rejects.toThrow(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      }
    });

    it("keeps root css alias reuse paired with the explicit css asset import when no local extraction is needed", async () => {
      const harness = await createViteHarness();
      const entrySource = await fs.promises.readFile(
        viteConsumerEntryPath,
        "utf8"
      );
      const transformedEntry = await harness.transform(
        viteConsumerEntryPath,
        entrySource
      );
      const {
        code,
        result: [extractedFile, extractedCss]
      } = await babelTransform(viteConsumerEntryPath);

      expect(transformedEntry).toBeNull();
      expect(extractedFile).toMatch(/^extracted_[^/]+\.css\.ts$/);
      expect(extractedCss).toBe("");
      expect(code).toContain(
        'import "@mincho-js-proof/define-rules-preset/shared-component.css";'
      );
      expect(code).toContain(
        'import { css, shared } from "@mincho-js-proof/define-rules-preset";'
      );
      expect(code).toContain("export { css, shared };");
    });

    it("defineRules provider sidecar import contract", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const entrySource = readFixtureSource(viteConsumerEntryPath);
      const providerDistModuleSource = readFixtureSource(
        providerDistModulePath
      );
      const providerSidecarCssSource = readFixtureSource(
        providerSidecarCssPath
      );
      const providerSharedClassName = extractVariableStringValueFromBuildSource(
        providerDistModuleSource,
        "shared"
      );

      expect(entrySource).toContain(explicitProviderSidecarImport);
      expectCssSourceToContainClassNames(
        providerSidecarCssSource,
        providerSharedClassName
      );
      expect(providerSidecarCssSource).toContain("color: rebeccapurple;");
      expect(providerSidecarCssSource).toContain("display: flex;");

      const {
        code,
        result: [extractedFile, extractedCss]
      } = await babelTransform(viteConsumerEntryPath);

      expect(extractedFile).toMatch(/^extracted_[^/]+\.css\.ts$/);
      expect(extractedCss).toBe("");
      expect(code).toContain(explicitProviderSidecarImport);
      expect(code).toContain(
        'import { css, shared } from "@mincho-js-proof/define-rules-preset";'
      );
      expect(code).toContain("export { css, shared };");
      expect(code).not.toContain(providerSharedClassName);

      const missingSidecarSource = entrySource.replace(
        explicitProviderSidecarImport,
        ""
      );
      expect(missingSidecarSource).not.toContain(explicitProviderSidecarImport);
      expect(missingSidecarSource).toContain(
        'import { css, shared } from "@mincho-js-proof/define-rules-preset";'
      );

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: missingSidecarSource,
        result: ["", ""]
      });

      const harness = await createViteHarness();
      const missingSidecarTransform = await harness.transform(
        viteConsumerEntryPath,
        missingSidecarSource
      );

      expect(missingSidecarTransform).toBeNull();
      expect(missingSidecarSource).not.toContain(providerSharedClassName);
    });

    it("defineRules presets survive cross-module HMR without stale preset duplication", async () => {
      const { defineRules } = await import("@mincho-js/css");
      const integrationModule = await import("@mincho-js/integration");
      const vanillaExtractIntegration =
        await import("@vanilla-extract/integration");
      const fileScopeModule = await import("@vanilla-extract/css/fileScope");

      fileScopeModule.setFileScope("hmr-provider.css.ts");
      const providerV1 = defineRules({
        debugId: "hmr-provider",
        properties: {
          color: true,
          display: true
        }
      });
      const staleProviderClassName = providerV1.css({
        color: "rebeccapurple",
        display: "block"
      });
      const providerV2 = defineRules({
        debugId: "hmr-provider",
        properties: {
          color: true,
          display: true
        }
      });
      const updatedProviderClassName = providerV2.css({
        color: "mediumseagreen",
        display: "flex"
      });
      const providerVirtualCssId =
        "node_modules/@mincho-js-proof/define-rules-preset/extracted_provider.css.ts.vanilla.css";
      const providerVirtualFilePath = providerVirtualCssId.replace(
        /\.vanilla\.css$/,
        ""
      );
      const expectedProviderVirtualModuleId = normalizePath(
        join(viteConsumerRootPath, providerVirtualCssId)
      );
      const providerVersions = [
        {
          className: staleProviderClassName,
          color: "rebeccapurple"
        },
        {
          className: updatedProviderClassName,
          color: "mediumseagreen"
        }
      ];
      let providerVersionIndex = 0;
      const createProviderCssSource = (className: string, color: string) =>
        splitClassNames(className)
          .map(
            (fragmentClassName) => `.${fragmentClassName} { color: ${color}; }`
          )
          .join("\n");
      const hmrModule: Module = {
        lastInvalidationTimestamp: 987
      };
      const getModuleById = vi.fn(() => hmrModule);
      const invalidateModule = vi.fn();

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_provider.css.ts";\nexport { css, shared };',
        result: ["extracted_provider.css.ts", "provider resolver contents"]
      });
      vi.spyOn(integrationModule, "compile").mockImplementation(
        async () =>
          ({
            source: `export const shared = ${JSON.stringify(providerVersions[providerVersionIndex]?.className)};`,
            watchFiles: []
          }) as Awaited<ReturnType<typeof compile>>
      );
      vi.spyOn(
        vanillaExtractIntegration,
        "processVanillaFile"
      ).mockImplementation(
        async ({
          source,
          serializeVirtualCssPath
        }: Parameters<typeof processVanillaFile>[0]) => {
          const providerVersion = providerVersions[providerVersionIndex];
          if (providerVersion == null) {
            throw new Error(
              "Expected a provider version for HMR serialization"
            );
          }
          const virtualImport =
            (await serializeVirtualCssPath?.({
              fileName: providerVirtualFilePath,
              fileScope: {
                filePath: providerVirtualFilePath
              },
              source: createProviderCssSource(
                providerVersion.className,
                providerVersion.color
              )
            })) ?? "";

          return `${virtualImport}\n${source}`;
        }
      );

      const harness = await createViteHarness({
        configOverrides: {
          command: "serve",
          mode: "development"
        },
        server: {
          moduleGraph: {
            getModuleById,
            invalidateModule
          }
        }
      });
      const { extractedId, extractedSource } =
        await createExtractedCssFixtureFromEntry(
          harness,
          providerRootFixturePath
        );
      const transformedProviderV1 = await harness.transform(
        extractedId,
        extractedSource
      );
      assertString(
        transformedProviderV1,
        "Expected first provider HMR transform to return source text"
      );
      const virtualImportMatch = transformedProviderV1.match(
        /import\s+"([^"]+\.vanilla\.css)";/
      );
      if (virtualImportMatch?.[1] == null) {
        throw new Error("Expected provider HMR output to import virtual CSS");
      }

      const resolvedVirtualId = harness.resolveId(virtualImportMatch[1]);
      expect(resolvedVirtualId).toBe(expectedProviderVirtualModuleId);
      expect(transformedProviderV1).toContain(staleProviderClassName);
      expect(transformedProviderV1).not.toContain(updatedProviderClassName);
      expect(await harness.load(resolvedVirtualId!)).toBe(
        createProviderCssSource(staleProviderClassName, "rebeccapurple")
      );
      expect(getModuleById).toHaveBeenCalledWith(
        expectedProviderVirtualModuleId
      );
      expect(invalidateModule).toHaveBeenCalledWith(hmrModule);
      expect(invalidateModule).toHaveBeenCalledTimes(1);
      expect(hmrModule.lastHMRTimestamp).toBe(987);

      providerVersionIndex = 1;
      const transformedProviderV2 = await harness.transform(
        extractedId,
        extractedSource
      );
      assertString(
        transformedProviderV2,
        "Expected updated provider HMR transform to return source text"
      );

      expect(transformedProviderV2).toContain(updatedProviderClassName);
      expect(transformedProviderV2).not.toContain(staleProviderClassName);
      expect(await harness.load(resolvedVirtualId!)).toBe(
        createProviderCssSource(updatedProviderClassName, "mediumseagreen")
      );
      expect(invalidateModule).toHaveBeenCalledTimes(2);
      expect(hmrModule.lastHMRTimestamp).toBe(987);

      const consumer = defineRules({
        debugId: "hmr-consumer",
        presets: providerV2.preset,
        properties: {
          color: true,
          display: true,
          padding: true
        }
      });
      const reusedUpdatedClassName = consumer.css({
        color: "mediumseagreen",
        display: "flex"
      });
      const seededEntryCount = Object.keys(providerV2.preset).length;
      const staleOnlyClassNames = splitClassNames(
        staleProviderClassName
      ).filter(
        (fragmentClassName) =>
          !splitClassNames(updatedProviderClassName).includes(fragmentClassName)
      );

      expect(reusedUpdatedClassName).toBe(updatedProviderClassName);
      expect(Object.keys(consumer.preset)).toHaveLength(seededEntryCount);
      expect(consumer.preset).toEqual(
        expect.objectContaining(providerV2.preset)
      );
      for (const staleClassName of staleOnlyClassNames) {
        expect(Object.values(consumer.preset)).not.toContain(staleClassName);
      }
      fileScopeModule.endFileScope();
    });

    it("keeps dev virtual css caching and HMR bookkeeping on the local path", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const vanillaExtractIntegration =
        await import("@vanilla-extract/integration");
      const cssSource = ".shared { color: rebeccapurple; }";
      const virtualCssId = "src/extracted_rules.css.ts.vanilla.css";
      const expectedModuleId = normalizePath(
        join(viteConsumerRootPath, virtualCssId)
      );
      const hmrModule: Module = {
        lastInvalidationTimestamp: 123
      };
      const getModuleById = vi.fn(() => hmrModule);
      const invalidateModule = vi.fn();
      const registryQueueSpy = vi.spyOn(
        integrationModule,
        "runDefineRulesPresetRegistryStep"
      );
      const registryFileSpy = vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      );

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css, shared };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      } as Awaited<ReturnType<typeof compile>>);
      vi.spyOn(
        vanillaExtractIntegration,
        "processVanillaFile"
      ).mockImplementation(
        async ({
          serializeVirtualCssPath
        }: Parameters<typeof processVanillaFile>[0]) => {
          return (
            (await serializeVirtualCssPath?.({
              fileName: "src/extracted_rules.css.ts",
              fileScope: {
                filePath: "src/extracted_rules.css.ts"
              },
              source: cssSource
            })) ?? ""
          );
        }
      );

      const harness = await createViteHarness({
        configOverrides: {
          command: "serve",
          mode: "development"
        },
        server: {
          moduleGraph: {
            getModuleById,
            invalidateModule
          }
        }
      });
      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);
      const transformedExtractedCss = await harness.transform(
        extractedId,
        extractedSource
      );
      assertString(
        transformedExtractedCss,
        "Expected extracted css transform to return source text"
      );

      const virtualImportMatch = transformedExtractedCss.match(
        /import\s+"([^"]+\.vanilla\.css)";/
      );
      if (virtualImportMatch == null) {
        throw new Error("Expected a virtual css import in dev mode");
      }

      expect(transformedExtractedCss).toContain(`import "${virtualCssId}";`);
      expect(transformedExtractedCss).not.toContain("presets");
      const resolvedVirtualId = harness.resolveId(virtualImportMatch[1]);
      expect(resolvedVirtualId).toBe(expectedModuleId);
      expect(await harness.load(resolvedVirtualId!)).toBe(cssSource);
      expect(getModuleById).toHaveBeenCalledWith(expectedModuleId);
      expect(invalidateModule).toHaveBeenCalledWith(hmrModule);
      expect(hmrModule.lastHMRTimestamp).toBe(123);
      expect(registryQueueSpy).not.toHaveBeenCalled();
      expect(registryFileSpy).not.toHaveBeenCalled();
    });
  });
}
