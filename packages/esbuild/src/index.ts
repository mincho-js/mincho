import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { processVanillaFile } from "@vanilla-extract/integration";
import { vanillaExtractPlugin } from "@vanilla-extract/esbuild-plugin";
import { type Plugin as EsbuildPlugin } from "esbuild";
import {
  babelTransform,
  compile,
  processDefineRulesPresetRegistryFile,
  runDefineRulesPresetRegistryStep
} from "@mincho-js/integration";

const integrationHelpers = {
  babelTransform,
  compile,
  processDefineRulesPresetRegistryFile,
  runDefineRulesPresetRegistryStep
};

const vanillaExtractIntegrationHelpers = {
  processVanillaFile
};

interface MinchoEsbuildPluginOptions {
  includeNodeModulesPattern?: RegExp;
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
  includeNodeModulesPattern
}: MinchoEsbuildPluginOptions = {}): EsbuildPlugin {
  return {
    name: "mincho-js-esbuild",
    setup(build) {
      const resolvers = new Map<string, string>();
      const resolverCache = new Map<string, string>();

      build.onEnd(() => {
        resolvers.clear();
        resolverCache.clear();
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

        const {
          code,
          result: [file, cssExtract]
        } = await integrationHelpers.babelTransform(args.path);

        // the extracted code and original are the same -> no css extracted
        if (file && cssExtract && cssExtract != code) {
          resolvers.set(file, cssExtract);
          resolverCache.delete(args.path);
        }

        return {
          contents: code,
          loader: args.path.match(/\.(ts|tsx)$/i) ? "ts" : "js",
          pluginData: {
            mainFilePath: args.path
          }
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

  const DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX =
    "__MINCHO_DEFINE_RULES_SENTINEL__:";
  const DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR =
    "defineRules preset backfill mismatch";
  const DEFINE_RULES_FUNCTION_CONFIG_DIAGNOSTIC =
    "defineRules serialized css does not support function-valued properties or shortcuts";
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
    consumer: string;
    multipleInstances: string;
  };

  type DefineRulesPresetSerializationManifest = {
    DEFINE_RULES_PRESET_SERIALIZATION_PATHS: DefineRulesPresetSerializationPaths;
    DEFINE_RULES_PRESET_SERIALIZATION_SUPPORTED_MATRIX_CASES: readonly DefineRulesPresetSerializationCase[];
    DEFINE_RULES_PRESET_SERIALIZATION_UNSUPPORTED_MATRIX_CASES: readonly DefineRulesPresetSerializationCase[];
    createDefineRulesPresetSerializationFixturePath: (
      relativePath: string
    ) => string;
  };

  let consumerFixturePath: string;
  let multipleInstancesFixturePath: string;
  let supportedFixtureMatrixCases: DefineRulesPresetSerializationFixtureCase[] =
    [];
  let unsupportedFixtureMatrixCases: DefineRulesPresetSerializationFixtureCase[] =
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
      DEFINE_RULES_PRESET_SERIALIZATION_SUPPORTED_MATRIX_CASES,
      DEFINE_RULES_PRESET_SERIALIZATION_UNSUPPORTED_MATRIX_CASES,
      createDefineRulesPresetSerializationFixturePath
    } = manifest;

    multipleInstancesFixturePath =
      createDefineRulesPresetSerializationFixturePath(
        DEFINE_RULES_PRESET_SERIALIZATION_PATHS.multipleInstances
      );
    consumerFixturePath = createDefineRulesPresetSerializationFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.consumer
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

  type LoadCallback = (args: MockLoadArgs) => Promise<unknown>;
  type ResolveCallback = (args: MockResolveArgs) => Promise<unknown>;
  type TestEsbuildApi = Parameters<typeof compile>[0]["esbuild"];

  function createBuildHarness({
    absWorkingDir = "/workspace",
    esbuild
  }: {
    absWorkingDir?: string;
    esbuild?: TestEsbuildApi;
  } = {}) {
    let extractedCssResolveCallback: ResolveCallback | undefined;
    let extractedCssLoadCallback: LoadCallback | undefined;
    let scriptLoadCallback: LoadCallback | undefined;

    const build = {
      esbuild: esbuild ?? {},
      initialOptions: {
        absWorkingDir,
        minify: false
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
      onEnd(): void {}
    } as unknown as Parameters<EsbuildPlugin["setup"]>[0];

    minchoEsbuildPlugin().setup(build);

    return {
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

  function createBackfilledBuildSource(): string {
    return `
      import { defineRules } from "@mincho-js/css";

      export const preset = defineRules({
        presets: {
          "shared": "shared_class"
        },
        properties: {
          color: true,
          display: true
        }
      });
    `;
  }

  function createLivePresetBuildSource(): string {
    return `
      import { defineRules } from "@mincho-js/css";

      export const { css } = defineRules({ properties: { background: true } });
      export const fillBlue = css({ background: "blue" });
    `;
  }

  function createLivePresetSmokeEntrySource(): string {
    return `
      import { css, defineRules } from "@mincho-js/css";

      const presetOwner = defineRules({
        debugId: "esbuild-build-smoke",
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

  function extractFillBlueClassName(source: string): string {
    const match = source.match(/fillBlue\s*=\s*["']([^"']+)["']/);
    if (match?.[1] == null) {
      throw new Error(
        "Expected build output to include a fillBlue class literal"
      );
    }

    return match[1];
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

  function injectDefineRulesPresetSentinels(
    source: string,
    sentinelIds: readonly string[]
  ): string {
    let nextSource = source;
    let searchIndex = 0;

    for (const sentinelId of sentinelIds) {
      const callStart = nextSource.indexOf("defineRules(", searchIndex);
      if (callStart === -1) {
        throw new Error(
          "Failed to locate a fixture defineRules call for sentinel injection"
        );
      }

      const openParenIndex = nextSource.indexOf("(", callStart);
      if (openParenIndex === -1) {
        throw new Error("Failed to locate a fixture defineRules config object");
      }

      let depth = 0;
      let closingParenIndex = -1;
      let activeQuote: '"' | "'" | "`" | undefined;
      let escaped = false;
      for (let index = openParenIndex; index < nextSource.length; index += 1) {
        const character = nextSource[index];
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

      nextSource = `${nextSource.slice(0, closingParenIndex)}, "${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}${sentinelId}"${nextSource.slice(closingParenIndex)}`;
      searchIndex =
        closingParenIndex +
        DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX.length +
        sentinelId.length +
        6;
    }

    return nextSource;
  }

  function createFixtureBuildSource(
    filePath: string,
    ...sentinelIds: string[]
  ): string {
    return injectDefineRulesPresetSentinels(
      readFixtureSource(filePath),
      sentinelIds
    );
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

  function findMatchingObjectBrace(
    source: string,
    openBraceIndex: number
  ): number {
    if (source[openBraceIndex] !== "{") {
      throw new Error("Expected an object literal opening brace");
    }

    let depth = 0;
    let activeQuote: '"' | "'" | "`" | undefined;
    let escaped = false;

    for (let index = openBraceIndex; index < source.length; index += 1) {
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

      if (character === "{") {
        depth += 1;
        continue;
      }

      if (character !== "}") {
        continue;
      }

      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }

    throw new Error("Failed to locate the closing brace for an object literal");
  }

  function extractObjectLiteralPropertyValuesFromBuildSource(
    source: string,
    propertyName: string
  ): string[] {
    const propertyPattern = new RegExp(
      `(?:^|[,\\{])\\s*(?:"${propertyName}"|'${propertyName}'|${propertyName})\\s*:`,
      "g"
    );
    const objectLiterals: string[] = [];

    while (propertyPattern.exec(source) != null) {
      const openBraceIndex = source.indexOf("{", propertyPattern.lastIndex);
      if (openBraceIndex === -1) {
        throw new Error(
          `Failed to locate object literal value for ${propertyName}`
        );
      }

      if (
        source.slice(propertyPattern.lastIndex, openBraceIndex).trim() !== ""
      ) {
        continue;
      }

      const closeBraceIndex = findMatchingObjectBrace(source, openBraceIndex);
      objectLiterals.push(source.slice(openBraceIndex, closeBraceIndex + 1));
      propertyPattern.lastIndex = closeBraceIndex + 1;
    }

    return objectLiterals;
  }

  function parseStringMapLiteral(
    objectLiteral: string
  ): Record<string, string> {
    try {
      return JSON.parse(objectLiteral) as Record<string, string>;
    } catch {
      const presetMap: Record<string, string> = {};

      for (const entryMatch of objectLiteral.matchAll(
        /(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$-]*))\s*:\s*(?:"([^"]*)"|'([^']*)')/g
      )) {
        const key = entryMatch[1] ?? entryMatch[2] ?? entryMatch[3];
        const value = entryMatch[4] ?? entryMatch[5];
        if (key != null && value != null) {
          presetMap[key] = value;
        }
      }

      if (
        Object.keys(presetMap).length === 0 &&
        objectLiteral.trim() !== "{}"
      ) {
        throw new Error("Failed to parse serialized preset map entries");
      }

      return presetMap;
    }
  }

  function extractPresetMapsFromBuildSource(
    source: string
  ): Array<Record<string, string>> {
    return extractObjectLiteralPropertyValuesFromBuildSource(
      source,
      "presets"
    ).map(parseStringMapLiteral);
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  function hasCssCallWithStringProperty(
    source: string,
    propertyName: string,
    propertyValue: string
  ): boolean {
    return new RegExp(
      `\\bcss\\s*\\(\\s*\\{[\\s\\S]*?${escapeRegExp(propertyName)}\\s*:\\s*["']${escapeRegExp(propertyValue)}["'][\\s\\S]*?\\}\\s*\\)`
    ).test(source);
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("minchoEsbuildPlugin", () => {
    it("extracts variable initializers from named export lists", () => {
      const source = `
        const fillBlue = "blue_class";
        export { css, fillBlue as fillBlueClass };
      `;

      expect(
        extractExportedVariableInitFromBuildSource(source, "fillBlue")
      ).toBe('"blue_class"');
    });

    it("builds a real esbuild fixture with defineRules preset backfill", async () => {
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
        expect(jsOutput.text).not.toMatch(
          new RegExp(
            `${escapeRegExp(DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX)}[^"']+`
          )
        );
        expect(jsOutput.text).not.toContain('background: "blue"');
        expect(cssOutput.text).toContain(`.${fillBlueClassName}`);
        expect(cssOutput.text).toContain("background: blue;");
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    });

    it("serializes live preset output with the class literal emitted for static css calls", async () => {
      const livePresetFixtureSource = createLivePresetBuildSource();
      expectSourceToContainSnippet(
        livePresetFixtureSource,
        "export const { css } = defineRules({ properties: { background: true } });"
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
        code: 'import "extracted_rules.css.ts";\nexport { css, fillBlue };',
        result: ["extracted_rules.css.ts", livePresetFixtureSource]
      });
      const registryQueueSpy = vi.spyOn(
        integrationHelpers,
        "runDefineRulesPresetRegistryStep"
      );
      const registryFileSpy = vi.spyOn(
        integrationHelpers,
        "processDefineRulesPresetRegistryFile"
      );

      const harness = createBuildHarness({
        absWorkingDir: process.cwd(),
        esbuild: realEsbuild
      });
      const scriptLoadResult = (await harness.loadScript({
        path: entryPath
      })) as {
        pluginData: {
          mainFilePath: string;
        };
      };
      const resolveResult = (await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: entryPath,
        pluginData: scriptLoadResult.pluginData
      })) as {
        path: string;
        pluginData: {
          path: string;
          mainFilePath: string;
        };
      };
      const loadResult = (await harness.loadExtractedCss({
        path: resolveResult.path,
        pluginData: resolveResult.pluginData
      })) as {
        contents: string;
        loader: string;
        resolveDir: string;
      };
      const fillBlueInit = extractExportedVariableInitFromBuildSource(
        loadResult.contents,
        "fillBlue"
      );
      const fillBlueClassName = extractExportedStringValueFromBuildSource(
        loadResult.contents,
        "fillBlue"
      );
      const serializedPresetMaps = extractPresetMapsFromBuildSource(
        loadResult.contents
      );
      const [serializedPresetMap] = serializedPresetMaps;

      expect(registryQueueSpy).toHaveBeenCalledTimes(1);
      expect(registryFileSpy).toHaveBeenCalledWith({
        source: expect.any(String),
        filePath: resolveResult.path,
        outputCss: undefined,
        identOption: "debug"
      });
      expect(loadResult.loader).toBe("js");
      expect(loadResult.resolveDir).toBe(dirname(resolveResult.path));
      expect(fillBlueInit).toMatch(/^(?:"[^"]+"|'[^']+')$/);
      expect(fillBlueClassName.split(/\s+/)).toHaveLength(1);
      expect(
        hasCssCallWithStringProperty(loadResult.contents, "background", "blue")
      ).toBe(false);
      expect(serializedPresetMaps).toHaveLength(1);
      if (serializedPresetMap == null) {
        throw new Error("Expected serialized css to include a preset map");
      }

      expect(
        Object.keys(serializedPresetMap).every(
          (key) => key.startsWith("fragment_") === false
        )
      ).toBe(true);
      expect(Object.values(serializedPresetMap)).toContain(fillBlueClassName);
      expect(loadResult.contents).toContain("presets");
      expect(loadResult.contents).not.toContain(
        DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX
      );
    });

    it("defineRules exported css rejects function-valued config", async () => {
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
      const realEsbuild = await import("esbuild");
      const entryPath = join(
        process.cwd(),
        "packages/esbuild/src/function-valued-config-entry.ts"
      );

      vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css };',
        result: ["extracted_rules.css.ts", functionValuedConfigBuildSource]
      });
      const harness = createBuildHarness({
        absWorkingDir: process.cwd(),
        esbuild: realEsbuild
      });
      const scriptLoadResult = (await harness.loadScript({
        path: entryPath
      })) as {
        pluginData: {
          mainFilePath: string;
        };
      };
      const resolveResult = (await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: entryPath,
        pluginData: scriptLoadResult.pluginData
      })) as {
        path: string;
        pluginData: {
          path: string;
          mainFilePath: string;
        };
      };

      await expect(
        harness.loadExtractedCss({
          path: resolveResult.path,
          pluginData: resolveResult.pluginData
        })
      ).rejects.toThrow(DEFINE_RULES_FUNCTION_CONFIG_DIAGNOSTIC);
    });

    it.skip("routes extracted css through shared preset backfill without breaking the namespace flow", async () => {
      const captureSession = {
        filePath: "/workspace/src/extracted_rules.css.ts",
        instances: [
          {
            sentinelId: "provider",
            filePath: "/workspace/src/extracted_rules.css.ts",
            instanceIndex: 0,
            getPresetSnapshot: () => ({
              shared: "shared_class"
            })
          }
        ]
      };

      vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
        code: "export const app = {};",
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationHelpers, "compile").mockResolvedValue({
        source: "compiled source"
      } as Awaited<ReturnType<typeof compile>>);
      const captureSpy = vi
        .spyOn(integrationHelpers, "captureDefineRulesPresetSession")
        .mockImplementation(
          async (_filePath: string, evaluate: () => Promise<string>) => ({
            result: await evaluate(),
            captureSession
          })
        );
      const backfillSpy = vi
        .spyOn(integrationHelpers, "backfillDefineRulesPresetArtifacts")
        .mockReturnValue([
          {
            filePath: "/workspace/src/extracted_rules.css.ts",
            source: createBackfilledBuildSource()
          }
        ]);
      const processVanillaFileSpy = vi
        .spyOn(vanillaExtractIntegrationHelpers, "processVanillaFile")
        .mockResolvedValue(createSentinelBuildSource("provider"));

      const harness = createBuildHarness();
      const scriptLoadResult = (await harness.loadScript({
        path: "/workspace/src/app.ts"
      })) as {
        pluginData: {
          mainFilePath: string;
        };
      };
      const resolveResult = (await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: "/workspace/src/app.ts",
        pluginData: scriptLoadResult.pluginData
      })) as {
        namespace: string;
        path: string;
        pluginData: {
          path: string;
          mainFilePath: string;
        };
      };
      const loadResult = (await harness.loadExtractedCss({
        path: resolveResult.path,
        pluginData: resolveResult.pluginData
      })) as {
        contents: string;
        loader: string;
        resolveDir: string;
      };

      expect(resolveResult).toEqual({
        namespace: "extracted-css",
        path: "/workspace/src/extracted_rules.css.ts",
        pluginData: {
          path: "extracted_rules.css.ts",
          mainFilePath: "/workspace/src/app.ts"
        }
      });
      expect(captureSpy).toHaveBeenCalledWith(
        "/workspace/src/extracted_rules.css.ts",
        expect.any(Function)
      );
      expect(processVanillaFileSpy).toHaveBeenCalledWith({
        source: "compiled source",
        filePath: "/workspace/src/extracted_rules.css.ts",
        outputCss: undefined,
        identOption: "debug"
      });
      expect(backfillSpy).toHaveBeenCalledWith(
        [
          {
            filePath: "/workspace/src/extracted_rules.css.ts",
            source: expect.stringContaining(
              `${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}provider`
            )
          }
        ],
        captureSession
      );
      expect(loadResult.loader).toBe("js");
      expect(loadResult.resolveDir).toBe("/workspace/src");
      expect(loadResult.contents).toContain("presets");
      expect(extractPresetMapsFromBuildSource(loadResult.contents)).toEqual([
        {
          shared: "shared_class"
        }
      ]);
      expect(loadResult.contents).not.toContain(
        DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX
      );
    });

    it.skip("backfills isolated raw preset maps from the multiple-instance fixture", async () => {
      const fixtureBuildSource = injectDefineRulesPresetSentinels(
        readFixtureSource(multipleInstancesFixturePath),
        ["primary", "secondary"]
      );

      expect(fixtureBuildSource).toContain(
        "export const preset = sharedPreset;"
      );
      expect(fixtureBuildSource).toContain("export const css = sharedCss;");
      const captureSession = {
        filePath: "/workspace/src/extracted_rules.css.ts",
        instances: [
          {
            sentinelId: "primary",
            filePath: "/workspace/src/extracted_rules.css.ts",
            instanceIndex: 0,
            getPresetSnapshot: () => ({
              shared: "shared_class"
            })
          },
          {
            sentinelId: "secondary",
            filePath: "/workspace/src/extracted_rules.css.ts",
            instanceIndex: 1,
            getPresetSnapshot: () => ({
              secondary: "secondary_class"
            })
          }
        ]
      };

      vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
        code: "export const app = {};",
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationHelpers, "compile").mockResolvedValue({
        source: "compiled source"
      } as Awaited<ReturnType<typeof compile>>);
      vi.spyOn(
        integrationHelpers,
        "captureDefineRulesPresetSession"
      ).mockImplementation(
        async (_filePath: string, evaluate: () => Promise<string>) => ({
          result: await evaluate(),
          captureSession
        })
      );
      const backfillSpy = vi.spyOn(
        integrationHelpers,
        "backfillDefineRulesPresetArtifacts"
      );
      vi.spyOn(
        vanillaExtractIntegrationHelpers,
        "processVanillaFile"
      ).mockResolvedValue(fixtureBuildSource);

      const harness = createBuildHarness();
      const scriptLoadResult = (await harness.loadScript({
        path: "/workspace/src/app.ts"
      })) as {
        pluginData: {
          mainFilePath: string;
        };
      };
      const resolveResult = (await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: "/workspace/src/app.ts",
        pluginData: scriptLoadResult.pluginData
      })) as {
        path: string;
        pluginData: {
          path: string;
          mainFilePath: string;
        };
      };
      const loadResult = (await harness.loadExtractedCss({
        path: resolveResult.path,
        pluginData: resolveResult.pluginData
      })) as {
        contents: string;
        loader: string;
        resolveDir: string;
      };

      expect(backfillSpy).toHaveBeenCalledWith(
        [
          {
            filePath: "/workspace/src/extracted_rules.css.ts",
            source: expect.stringContaining(
              `${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}primary`
            )
          }
        ],
        captureSession
      );
      expect(loadResult.loader).toBe("js");
      expect(loadResult.resolveDir).toBe("/workspace/src");
      expect(loadResult.contents).toContain("presets");
      expect(loadResult.contents).not.toContain(
        DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX
      );
      expect(loadResult.contents).toContain(
        "export const preset = sharedPreset;"
      );
      expect(loadResult.contents).toContain("export const css = sharedCss;");
      expect(extractPresetMapsFromBuildSource(loadResult.contents)).toEqual([
        {
          shared: "shared_class"
        },
        {
          secondary: "secondary_class"
        }
      ]);
    });

    it.skip("backfills supported fixture matrix cases through the esbuild extracted-css matrix path", async () => {
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
        let captureSession:
          | ReturnType<typeof createPresetCaptureSession>
          | undefined;

        vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
          code: "export const app = {};",
          result: ["extracted_rules.css.ts", "resolver contents"]
        });
        vi.spyOn(integrationHelpers, "compile").mockResolvedValue({
          source: "compiled source"
        } as Awaited<ReturnType<typeof compile>>);
        vi.spyOn(
          integrationHelpers,
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
          integrationHelpers,
          "backfillDefineRulesPresetArtifacts"
        );
        vi.spyOn(
          vanillaExtractIntegrationHelpers,
          "processVanillaFile"
        ).mockResolvedValue(buildSource);

        const harness = createBuildHarness();
        const scriptLoadResult = (await harness.loadScript({
          path: "/workspace/src/app.ts"
        })) as {
          pluginData: {
            mainFilePath: string;
          };
        };
        const resolveResult = (await harness.resolveExtractedCss({
          path: "extracted_rules.css.ts",
          importer: "/workspace/src/app.ts",
          pluginData: scriptLoadResult.pluginData
        })) as {
          path: string;
          pluginData: {
            path: string;
            mainFilePath: string;
          };
        };
        const loadResult = (await harness.loadExtractedCss({
          path: resolveResult.path,
          pluginData: resolveResult.pluginData
        })) as {
          contents: string;
          loader: string;
          resolveDir: string;
        };

        expect(backfillSpy).toHaveBeenCalledWith(
          [
            {
              filePath: "/workspace/src/extracted_rules.css.ts",
              source: expect.stringContaining(
                `${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}${fixtureCase.caseId}`
              )
            }
          ],
          captureSession
        );
        expect(backfillSpy).toHaveBeenCalledTimes(1);
        expect(loadResult.loader).toBe("js");
        expect(loadResult.resolveDir).toBe("/workspace/src");

        for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
          expectSourceToContainSnippet(
            loadResult.contents,
            expectedSourceSnippet
          );
        }

        expect(extractPresetMapsFromBuildSource(loadResult.contents)).toEqual([
          presetMap
        ]);
        expect(loadResult.contents).toContain("presets");
        expect(loadResult.contents).not.toContain(
          DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX
        );
      }
    });

    it.skip("keeps the locked mismatch boundary for unsupported fixture matrix cases through the esbuild extracted-css path", async () => {
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

        vi.spyOn(integrationHelpers, "babelTransform").mockResolvedValue({
          code: "export const app = {};",
          result: ["extracted_rules.css.ts", "resolver contents"]
        });
        vi.spyOn(integrationHelpers, "compile").mockResolvedValue({
          source: "compiled source"
        } as Awaited<ReturnType<typeof compile>>);
        vi.spyOn(
          integrationHelpers,
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
          vanillaExtractIntegrationHelpers,
          "processVanillaFile"
        ).mockResolvedValue(buildSource);

        const harness = createBuildHarness();
        const scriptLoadResult = (await harness.loadScript({
          path: "/workspace/src/app.ts"
        })) as {
          pluginData: {
            mainFilePath: string;
          };
        };
        const resolveResult = (await harness.resolveExtractedCss({
          path: "extracted_rules.css.ts",
          importer: "/workspace/src/app.ts",
          pluginData: scriptLoadResult.pluginData
        })) as {
          path: string;
          pluginData: {
            path: string;
            mainFilePath: string;
          };
        };

        await expect(
          harness.loadExtractedCss({
            path: resolveResult.path,
            pluginData: resolveResult.pluginData
          })
        ).rejects.toThrow(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
      }
    });

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
      const registryFileSpy = vi
        .spyOn(integrationHelpers, "processDefineRulesPresetRegistryFile")
        .mockRejectedValue(new ReferenceError("window is not defined"));

      const harness = createBuildHarness();
      const scriptLoadResult = (await harness.loadScript({
        path: "/workspace/src/app.ts"
      })) as {
        pluginData: {
          mainFilePath: string;
        };
      };
      const resolveResult = (await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: "/workspace/src/app.ts",
        pluginData: scriptLoadResult.pluginData
      })) as {
        path: string;
        pluginData: {
          path: string;
          mainFilePath: string;
        };
      };
      const loadResult = (await harness.loadExtractedCss({
        path: resolveResult.path,
        pluginData: resolveResult.pluginData
      })) as {
        errors: Array<{
          text: string;
          detail: string;
        }>;
      };

      expect(registryFileSpy).toHaveBeenCalledWith({
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

    it.skip("defineRules preset capture sessions are queued so concurrent esbuild loads cannot overlap shared preset sessions", async () => {
      const firstDeferred = createDeferred<string>();
      const secondDeferred = createDeferred<string>();
      const processOrder: string[] = [];
      const captureSessions = new Map<
        string,
        ReturnType<typeof createPresetCaptureSession>
      >();

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
      vi.spyOn(
        integrationHelpers,
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
        integrationHelpers,
        "backfillDefineRulesPresetArtifacts"
      );
      vi.spyOn(
        vanillaExtractIntegrationHelpers,
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

      const harness = createBuildHarness();
      const scriptLoadResultA = (await harness.loadScript({
        path: "/workspace/src/app-a.ts"
      })) as {
        pluginData: {
          mainFilePath: string;
        };
      };
      const scriptLoadResultB = (await harness.loadScript({
        path: "/workspace/src/app-b.ts"
      })) as {
        pluginData: {
          mainFilePath: string;
        };
      };
      const resolveResultA = (await harness.resolveExtractedCss({
        path: "extracted_a.css.ts",
        importer: "/workspace/src/app-a.ts",
        pluginData: scriptLoadResultA.pluginData
      })) as {
        path: string;
        pluginData: {
          path: string;
          mainFilePath: string;
        };
      };
      const resolveResultB = (await harness.resolveExtractedCss({
        path: "extracted_b.css.ts",
        importer: "/workspace/src/app-b.ts",
        pluginData: scriptLoadResultB.pluginData
      })) as {
        path: string;
        pluginData: {
          path: string;
          mainFilePath: string;
        };
      };

      const firstLoadPromise = harness.loadExtractedCss({
        path: resolveResultA.path,
        pluginData: resolveResultA.pluginData
      }) as Promise<{
        contents: string;
      }>;
      const secondLoadPromise = harness.loadExtractedCss({
        path: resolveResultB.path,
        pluginData: resolveResultB.pluginData
      }) as Promise<{
        contents: string;
      }>;

      await vi.waitFor(() => {
        expect(processOrder).toEqual([
          "start:/workspace/src/extracted_a.css.ts"
        ]);
      });

      firstDeferred.resolve(createSentinelBuildSource("provider-a"));
      const firstLoadResult = await firstLoadPromise;

      await vi.waitFor(() => {
        expect(processOrder).toEqual([
          "start:/workspace/src/extracted_a.css.ts",
          "end:/workspace/src/extracted_a.css.ts",
          "start:/workspace/src/extracted_b.css.ts"
        ]);
      });

      secondDeferred.resolve(createSentinelBuildSource("provider-b"));
      const secondLoadResult = await secondLoadPromise;

      expect(processOrder).toEqual([
        "start:/workspace/src/extracted_a.css.ts",
        "end:/workspace/src/extracted_a.css.ts",
        "start:/workspace/src/extracted_b.css.ts",
        "end:/workspace/src/extracted_b.css.ts"
      ]);
      expect(backfillSpy).toHaveBeenNthCalledWith(
        1,
        [
          {
            filePath: "/workspace/src/extracted_a.css.ts",
            source: expect.stringContaining("provider-a")
          }
        ],
        captureSessions.get("/workspace/src/extracted_a.css.ts")
      );
      expect(backfillSpy).toHaveBeenNthCalledWith(
        2,
        [
          {
            filePath: "/workspace/src/extracted_b.css.ts",
            source: expect.stringContaining("provider-b")
          }
        ],
        captureSessions.get("/workspace/src/extracted_b.css.ts")
      );
      expect(
        extractPresetMapsFromBuildSource(firstLoadResult.contents)
      ).toEqual([
        {
          "provider-a": "provider-a_class"
        }
      ]);
      expect(
        extractPresetMapsFromBuildSource(secondLoadResult.contents)
      ).toEqual([
        {
          "provider-b": "provider-b_class"
        }
      ]);
      expect(firstLoadResult.contents).not.toContain("provider-b_class");
      expect(secondLoadResult.contents).not.toContain("provider-a_class");
    });
  });
}
