import {
  type BabelOptions,
  babelTransform,
  compile,
  processDefineRulesPresetRegistryFile,
  runDefineRulesPresetRegistryStep
} from "@mincho-js/integration";
import { normalizePath } from "@rollup/pluginutils";
import { dirname, join, resolve } from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

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
          resolverCache.delete(moduleInfo.originalPath);
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

          const contents = await processDefineRulesPresetViteFile({
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
          });

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

let collectDefineRulesPresetViteRegistrySource:
  | ((source: string) => void)
  | undefined;

async function processDefineRulesPresetViteFile(
  options: Parameters<typeof processDefineRulesPresetRegistryFile>[0]
): Promise<string> {
  const { source } = await runDefineRulesPresetRegistryStep(() =>
    processDefineRulesPresetRegistryFile(options)
  );
  collectDefineRulesPresetViteRegistrySource?.(source);

  return source;
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

  const DEFINE_RULES_PRESET_SCHEMA = "mincho.defineRulesPreset";
  const explicitProviderSidecarImport =
    'import "@mincho-js-proof/define-rules-preset/shared-component.css";';
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
    providerDistModule: string;
    providerRoot: string;
    providerSidecarCss: string;
    viteConsumerEntry: string;
    viteConsumerRoot: string;
  };

  type DefineRulesPresetSerializationManifest = {
    DEFINE_RULES_PRESET_SERIALIZATION_PATHS: DefineRulesPresetSerializationPaths;
    DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES: readonly DefineRulesPresetSerializationCase[];
    createDefineRulesPresetSerializationFixturePath: (
      relativePath: string
    ) => string;
  };

  let providerDistModulePath: string;
  let providerRootFixturePath: string;
  let providerSidecarCssPath: string;
  let registryFixtureMatrixCases: DefineRulesPresetSerializationFixtureCase[] =
    [];
  let serializedRegistryFixtureCases: DefineRulesPresetSerializationFixtureCase[] =
    [];
  let viteConsumerEntryPath: string;
  let viteConsumerRootPath: string;

  function getDefineRulesPresetSerializationManifestUrl(): string {
    return new URL(
      "../../integration/src/__fixtures__/defineRules-preset-serialization/manifest.ts",
      import.meta.url
    ).href;
  }

  function createViteFixtureCacheRoot(): string {
    return join(fileURLToPath(new URL("..", import.meta.url)), ".cache");
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

  function expectSourceToContainV4RuntimePresetSeed(source: string): void {
    expect(source).toMatch(
      new RegExp(
        `["']?schema["']?\\s*:\\s*["']${escapeRegExp(DEFINE_RULES_PRESET_SCHEMA)}["']`
      )
    );
    expect(source).toMatch(/["']?version["']?\s*:\s*4/);
    expect(source).toMatch(/["']?classNameByCache["']?\s*:\s*\{/);
    expect(source).toMatch(/["']?writeKeyByCacheKey["']?\s*:\s*\{/);
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

  function countV4PresetArtifacts(source: string): number {
    return Array.from(
      source.matchAll(
        /["']?schema["']?\s*:\s*["']mincho\.defineRulesPreset["']/g
      )
    ).length;
  }

  function expectSourceToContainPopulatedClassNameByCache(
    source: string
  ): void {
    expect(source).toMatch(
      /["']?classNameByCache["']?\s*:\s*\{[\s\S]*["'][^"']+["']\s*:/
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

  function createLivePresetSmokeEntrySource(): string {
    return `
      import { css as vanillaCss, defineRules } from "@mincho-js/css";

      export const { css: presetCss, preset } = defineRules({
        debugId: "vite-build-smoke",
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
    const cacheRoot = createViteFixtureCacheRoot();
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

  async function createRealViteRegistryFixture(
    fixtureCase: DefineRulesPresetSerializationFixtureCase
  ) {
    const cacheRoot = createViteFixtureCacheRoot();
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

  async function buildRealViteRegistryFixture(
    fixtureCase: DefineRulesPresetSerializationFixtureCase
  ) {
    const { build } = await import("vite");
    const { entryPath, root } =
      await createRealViteRegistryFixture(fixtureCase);

    const fixtureSource = await fs.promises.readFile(
      join(root, "src/index.css.ts"),
      "utf8"
    );
    const integrationModule = await import("@mincho-js/integration");
    const babelTransformSpy = vi
      .spyOn(integrationModule, "babelTransform")
      .mockResolvedValue({
        code: 'import "extracted_registry.css.ts";\nexport const __registryBuildMarker = "entry";',
        result: ["extracted_registry.css.ts", fixtureSource]
      });
    const registrySources: string[] = [];
    collectDefineRulesPresetViteRegistrySource = (source) => {
      registrySources.push(source);
    };

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
      type ViteRegistryOutput =
        | { code: string; fileName: string; type: "chunk" }
        | { fileName: string; source: string | Uint8Array; type: "asset" };
      const rollupOutputs = Array.isArray(buildResult)
        ? buildResult
        : [buildResult];
      const outputFiles = rollupOutputs.flatMap((rollupOutput) => {
        const possibleRollupOutput = rollupOutput as { output?: unknown };
        if (!Array.isArray(possibleRollupOutput.output)) {
          throw new Error(
            "Expected Vite registry build to return Rollup output"
          );
        }

        return possibleRollupOutput.output as ViteRegistryOutput[];
      });
      const jsOutput = outputFiles.find(
        (output) =>
          output.type === "chunk" && /\.(?:mjs|js)$/.test(output.fileName)
      );
      const cssOutput = outputFiles.find(
        (output) => output.type === "asset" && output.fileName.endsWith(".css")
      );

      if (jsOutput?.type !== "chunk") {
        throw new Error("Expected Vite registry build to emit an ES chunk");
      }

      return {
        css: cssOutput?.type === "asset" ? String(cssOutput.source) : "",
        js: jsOutput.code,
        registrySource: registrySources.join("\n")
      };
    } finally {
      collectDefineRulesPresetViteRegistrySource = undefined;
      babelTransformSpy.mockRestore();
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  }

  function extractAssignedStringValueFromBuildSource(
    source: string,
    assignmentName: string
  ): string {
    const match = source.match(
      new RegExp(`${escapeRegExp(assignmentName)}\\s*=\\s*["']([^"']+)["']`)
    );
    if (match?.[1] == null) {
      throw new Error(
        `Expected build output to include a ${assignmentName} string literal`
      );
    }

    return match[1];
  }

  function extractFillBlueClassName(source: string): string {
    return extractAssignedStringValueFromBuildSource(source, "fillBlue");
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
    it("defineRules preset registry steps are queued in Vite extracted transforms", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const firstDeferred = createDeferred<string>();
      const secondDeferred = createDeferred<string>();
      const processOrder: string[] = [];

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
      const registrySpy = vi
        .spyOn(integrationModule, "processDefineRulesPresetRegistryFile")
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

      firstDeferred.resolve(createV4PresetBuildSource("provider-a_class"));
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

      secondDeferred.resolve(createV4PresetBuildSource("provider-b_class"));
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
      expect(registrySpy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          filePath: firstFixture.extractedId,
          identOption: "short",
          source: `compiled source:${firstFixture.extractedId}`,
          serializeVirtualCssPath: expect.any(Function)
        })
      );
      expect(registrySpy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          filePath: secondFixture.extractedId,
          identOption: "short",
          source: `compiled source:${secondFixture.extractedId}`,
          serializeVirtualCssPath: expect.any(Function)
        })
      );
      expectSourceToContainClassNameByCacheValue(
        firstTransformResult,
        "provider-a_class"
      );
      expectSourceToContainClassNameByCacheValue(
        secondTransformResult,
        "provider-b_class"
      );
      expect(firstTransformResult).not.toContain("provider-b_class");
      expect(secondTransformResult).not.toContain("provider-a_class");
    });

    it("uses registry wrapper source for build output preset artifacts", async () => {
      const integrationModule = await import("@mincho-js/integration");

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css, shared };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      } as Awaited<ReturnType<typeof compile>>);
      const registrySpy = vi
        .spyOn(integrationModule, "processDefineRulesPresetRegistryFile")
        .mockResolvedValue(
          createRegistryResult(createV4PresetBuildSource("shared_class"))
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

      expect(registrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: extractedId,
          identOption: "short",
          source: "compiled source",
          serializeVirtualCssPath: expect.any(Function)
        })
      );
      expect(registrySpy).toHaveBeenCalledTimes(1);
      expectSourceToContainClassNameByCacheValue(
        transformedExtractedCss,
        "shared_class"
      );
    });

    it("builds a real Vite fixture with defineRules preset registry artifact", async () => {
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
        expectSourceToContainV4RuntimePresetSeed(jsOutput.code);
        expect(jsOutput.code).not.toContain('background: "blue"');
        expect(cssOutput.source).toContain(`.${fillBlueClassName}`);
        expect(cssOutput.source).toContain("background: blue;");
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    }, 20000);

    it("real Vite registry builds helper-wrapped, IIFE, nested, multiple instances, and imported helper fixtures", async () => {
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
          await buildRealViteRegistryFixture(fixtureCase);

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
    }, 20000);

    it("real Vite function-valued config build skips registry artifacts", async () => {
      const fixtureCase = registryFixtureMatrixCases.find(
        (candidate) => candidate.caseId === "registry-function-config-invalid"
      );
      if (fixtureCase == null) {
        throw new Error("Missing registry function config fixture case");
      }

      const { js, registrySource } =
        await buildRealViteRegistryFixture(fixtureCase);

      expect(registrySource).not.toBe("");
      expect(countV4PresetArtifacts(registrySource)).toBe(0);
      expect(countV4PresetArtifacts(js)).toBe(0);
      expect(registrySource).toContain("rebeccapurple");
    }, 20000);

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
      const registrySpy = vi.spyOn(
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
      expect(registrySpy).toHaveBeenCalledTimes(1);
      expectSourceToContainClassNameByCacheValue(
        transformedExtractedCss,
        fillBlueClassName
      );
      expect(fillBlueClassName.split(/\s+/)).toHaveLength(1);
      expect(fillBlueInitializer).not.toMatch(/\bcss\s*\(/);
      expect(
        hasCssCallWithStringProperty(
          transformedExtractedCss,
          "background",
          "blue"
        )
      ).toBe(false);
    });

    it("defineRules exported css skips function-valued registry artifacts", async () => {
      const integrationModule = await import("@mincho-js/integration");
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

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { raw };',
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
      const registrySpy = vi.spyOn(
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
        "Expected function-valued config transform to return source text"
      );

      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(countV4PresetArtifacts(transformedExtractedCss)).toBe(0);
      expect(transformedExtractedCss).toContain("blue");
    });

    it("bubbles registry processing errors from build-time preset serialization", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { raw };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      } as Awaited<ReturnType<typeof compile>>);
      const registrySpy = vi
        .spyOn(integrationModule, "processDefineRulesPresetRegistryFile")
        .mockRejectedValue(new Error("registry processing failure"));

      const harness = await createViteHarness();
      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);

      await expect(
        harness.transform(extractedId, extractedSource)
      ).rejects.toThrow("registry processing failure");
      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("serializes supported fixture matrix cases through the Vite extracted-css registry path", async () => {
      for (const fixtureCase of serializedRegistryFixtureCases) {
        vi.restoreAllMocks();

        const fixtureSource = readFixtureSource(fixtureCase.fixturePath);
        for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
          expectSourceToContainSnippet(fixtureSource, expectedSourceSnippet);
        }

        const integrationModule = await import("@mincho-js/integration");
        vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
          code: 'import "extracted_rules.css.ts";\nexport { css, preset, shared };',
          result: ["extracted_rules.css.ts", "resolver contents"]
        });
        const compileFixtureSource: typeof compile = integrationModule.compile;
        vi.spyOn(integrationModule, "compile").mockImplementation(
          (options: Parameters<typeof compileFixtureSource>[0]) =>
            compileFixtureSource({
              ...options,
              filePath: fixtureCase.fixturePath,
              originalPath: fixtureCase.fixturePath,
              contents: fixtureSource
            })
        );
        const registrySpy = vi.spyOn(
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

        expect(registrySpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: extractedId,
            identOption: "short",
            serializeVirtualCssPath: expect.any(Function)
          })
        );
        expect(registrySpy).toHaveBeenCalledTimes(1);
        expectSourceToContainV4PresetArtifact(transformedExtractedCss);
        expectSourceToContainPopulatedClassNameByCache(transformedExtractedCss);
      }
    });

    it("keeps function-valued config fixture artifact-free through the Vite registry path", async () => {
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

      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { raw };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      const compileFixtureSource: typeof compile = integrationModule.compile;
      vi.spyOn(integrationModule, "compile").mockImplementation(
        (options: Parameters<typeof compileFixtureSource>[0]) =>
          compileFixtureSource({
            ...options,
            filePath: fixtureCase.fixturePath,
            originalPath: fixtureCase.fixturePath,
            contents: fixtureSource
          })
      );
      const registrySpy = vi.spyOn(
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
        "Expected function-valued fixture transform to return source text"
      );

      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(countV4PresetArtifacts(transformedExtractedCss)).toBe(0);
      expect(transformedExtractedCss).toContain("rebeccapurple");
    }, 20000);

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

    it("drops stale registry artifacts during repeated HMR-style transforms", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const createStaleRegistrySource = (includeRemovedOwner: boolean) => {
        const removedOwnerSource = includeRemovedOwner
          ? `
              const removedOwner = defineRules({
                debugId: "vite-removed-stale",
                properties: {
                  padding: true
                }
              });
              export const removedClass = removedOwner.css({ padding: 12 });
              export const removedPreset = removedOwner.preset;
            `
          : "";

        return `
          import { defineRules } from "@mincho-js/css";

          const currentOwner = defineRules({
            debugId: "vite-current-stale",
            properties: {
              color: true
            }
          });
          ${removedOwnerSource}
          export const currentClass = currentOwner.css({ color: "navy" });
          export const currentPreset = currentOwner.preset;
        `;
      };
      const firstRegistrySource = createStaleRegistrySource(true);
      const secondRegistrySource = createStaleRegistrySource(false);

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_stale.css.ts";\nexport { currentClass };',
        result: ["extracted_stale.css.ts", "resolver contents"]
      });
      const registrySpy = vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      );

      const harness = await createViteHarness({
        configOverrides: {
          command: "serve",
          mode: "development"
        }
      });
      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);
      expect(extractedSource).toBe("resolver contents");
      const firstTransform = await harness.transform(
        extractedId,
        firstRegistrySource
      );
      assertString(
        firstTransform,
        "Expected first repeated transform to return source text"
      );
      const firstVirtualImportMatch = firstTransform.match(
        /import\s+"([^"]+\.vanilla\.css)";/
      );
      if (firstVirtualImportMatch?.[1] == null) {
        throw new Error(
          "Expected first repeated transform to import virtual CSS"
        );
      }
      const resolvedVirtualId = harness.resolveId(firstVirtualImportMatch[1]);
      assertString(
        resolvedVirtualId,
        "Expected repeated transform virtual CSS id to resolve"
      );
      const currentClassName = extractVariableStringValueFromBuildSource(
        firstTransform,
        "currentClass"
      );
      const removedClassName = extractVariableStringValueFromBuildSource(
        firstTransform,
        "removedClass"
      );
      expect(removedClassName).not.toBe(currentClassName);
      const firstVirtualCss = await harness.load(resolvedVirtualId);
      assertString(
        firstVirtualCss,
        "Expected first repeated transform virtual CSS to load"
      );

      expect(registrySpy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          filePath: extractedId,
          identOption: "debug",
          serializeVirtualCssPath: expect.any(Function)
        })
      );
      expect(countV4PresetArtifacts(firstTransform)).toBe(2);
      expectSourceToContainClassNameByCacheValue(
        firstTransform,
        currentClassName
      );
      expectSourceToContainClassNameByCacheValue(
        firstTransform,
        removedClassName
      );
      expectCssSourceToContainClassNames(firstVirtualCss, currentClassName);
      expectCssSourceToContainClassNames(firstVirtualCss, removedClassName);

      const secondTransform = await harness.transform(
        extractedId,
        secondRegistrySource
      );
      assertString(
        secondTransform,
        "Expected second repeated transform to return source text"
      );
      const secondCurrentClassName = extractVariableStringValueFromBuildSource(
        secondTransform,
        "currentClass"
      );
      const secondVirtualCss = await harness.load(resolvedVirtualId);
      assertString(
        secondVirtualCss,
        "Expected second repeated transform virtual CSS to load"
      );

      expect(registrySpy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          filePath: extractedId,
          identOption: "debug",
          serializeVirtualCssPath: expect.any(Function)
        })
      );
      expect(countV4PresetArtifacts(secondTransform)).toBe(1);
      expectSourceToContainClassNameByCacheValue(
        secondTransform,
        secondCurrentClassName
      );
      expect(secondTransform).not.toContain(removedClassName);
      expect(secondTransform).not.toContain("removedClass");
      expect(secondTransform).not.toContain("removedPreset");
      expectCssSourceToContainClassNames(
        secondVirtualCss,
        secondCurrentClassName
      );
      for (const removedFragmentClassName of splitClassNames(
        removedClassName
      )) {
        expect(secondVirtualCss).not.toContain(`.${removedFragmentClassName}`);
      }
      expect(registrySpy).toHaveBeenCalledTimes(2);
    });

    it("defineRules presets survive cross-module HMR without stale preset duplication", async () => {
      const { defineRules } = await import("@mincho-js/css");
      const integrationModule = await import("@mincho-js/integration");
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
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      ).mockImplementation(
        async ({
          source,
          serializeVirtualCssPath
        }: Parameters<typeof processDefineRulesPresetRegistryFile>[0]) => {
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

          return createRegistryResult(`${virtualImport}\n${source}`);
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
      const providerClassNameByCache = providerV2.preset.classNameByCache;
      const consumerClassNameByCache = consumer.preset.classNameByCache;
      const seededEntryCount = Object.keys(providerClassNameByCache).length;
      const staleOnlyClassNames = splitClassNames(
        staleProviderClassName
      ).filter(
        (fragmentClassName) =>
          !splitClassNames(updatedProviderClassName).includes(fragmentClassName)
      );

      expect(reusedUpdatedClassName).toBe(updatedProviderClassName);
      expect(Object.keys(consumerClassNameByCache)).toHaveLength(
        seededEntryCount
      );
      expect(consumerClassNameByCache).toEqual(
        expect.objectContaining(providerClassNameByCache)
      );
      for (const staleClassName of staleOnlyClassNames) {
        expect(Object.values(consumerClassNameByCache)).not.toContain(
          staleClassName
        );
      }
      fileScopeModule.endFileScope();
    });

    it("keeps dev virtual css caching and HMR bookkeeping on the local path", async () => {
      const integrationModule = await import("@mincho-js/integration");
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

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css, shared };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      } as Awaited<ReturnType<typeof compile>>);
      const registrySpy = vi
        .spyOn(integrationModule, "processDefineRulesPresetRegistryFile")
        .mockImplementation(
          async ({
            serializeVirtualCssPath
          }: Parameters<typeof processDefineRulesPresetRegistryFile>[0]) => {
            return createRegistryResult(
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
      expect(registrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: extractedId,
          identOption: "debug",
          source: "compiled source",
          serializeVirtualCssPath: expect.any(Function)
        })
      );
      expect(registrySpy).toHaveBeenCalledTimes(1);
    });
  });
}
