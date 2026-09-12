import { jsxSyntaxPluginPath, typescriptPresetPath } from "./babelPreset.js";
import { internalStripStaticCssEvalRequestQuery } from "./staticCssEvalUtils.js";
import { basename, dirname, extname, join, resolve } from "node:path";
import * as fs from "node:fs";
import { addFileScope, getPackageInfo } from "@vanilla-extract/integration";
import defaultEsbuild, {
  type BuildOptions,
  type Plugin,
  type PluginBuild
} from "esbuild";
import { transformSync } from "@babel/core";
import { minchoStyledComponentPlugin } from "@mincho-js/babel";

interface CompileOptions {
  esbuild?: PluginBuild["esbuild"];
  filePath: string;
  contents: string;
  cwd?: string;
  externals?: Array<string>;
  loader?: BuildOptions["loader"];
  plugins?: BuildOptions["plugins"];

  /** Transaction-owned input reader used by multi-pass build integrations. */
  readFile?: (path: string) => Promise<string>;
  readFileBytes?: (path: string) => Promise<Uint8Array>;
  resolverCache: Map<string, string>;
  originalPath: string;
}

function getScopedSourceWithCache({
  contents,
  originalPath,
  packageName,
  rootPath,
  resolverCache
}: {
  contents: string;
  originalPath: string;
  packageName: string;
  rootPath: string;
  resolverCache: Map<string, string>;
}) {
  if (resolverCache.has(originalPath)) {
    return resolverCache.get(originalPath)!;
  }

  const source = addFileScope({
    source: contents,
    filePath: originalPath,
    rootPath,
    packageName
  });

  resolverCache.set(originalPath, source);

  return source;
}

function transformScopedDependencySource({
  contents,
  filePath,
  loader,
  packageName,
  rootPath
}: {
  contents: string;
  filePath: string;
  loader: "js" | "jsx" | "ts" | "tsx";
  packageName: string;
  rootPath: string;
}) {
  let source = addFileScope({
    source: contents,
    filePath,
    rootPath,
    packageName
  });

  source = transformSync(source, {
    filename: filePath,
    plugins: [
      ...(loader === "jsx" || loader === "tsx" ? [jsxSyntaxPluginPath] : []),
      minchoStyledComponentPlugin()
    ],
    presets:
      loader === "ts" || loader === "tsx"
        ? [
            [
              typescriptPresetPath,
              { allExtensions: true, isTSX: loader === "tsx" }
            ]
          ]
        : [],
    sourceMaps: false
  })!.code!;

  return source;
}

function createScopedOnLoadPlugin(
  packageName: string,
  loaders: BuildOptions["loader"] = {},
  readFile: (path: string) => Promise<string> = (path) =>
    fs.promises.readFile(path, "utf-8"),
  readFileBytes?: (path: string) => Promise<Uint8Array>
) {
  return {
    name: "mincho:custom-extract-scope",

    setup(build: PluginBuild) {
      build.onLoad(
        { filter: /.*/, namespace: "file" },
        async (args: { path: string }) => {
          const extension = extname(args.path);
          const configuredExtension = Object.keys(loaders)
            .sort((left, right) => right.length - left.length)
            .find((candidate) => args.path.endsWith(candidate));

          const loader =
            (configuredExtension ? loaders[configuredExtension] : undefined) ??
            (extension === ".tsx"
              ? "tsx"
              : extension === ".jsx"
                ? "jsx"
                : /\.[cm]?ts$/.test(extension)
                  ? "ts"
                  : /\.[cm]?js$/.test(extension)
                    ? "js"
                    : undefined);

          if (
            loader !== "js" &&
            loader !== "jsx" &&
            loader !== "ts" &&
            loader !== "tsx"
          ) {
            const nativeLoader =
              loader ?? (args.path.endsWith(".json") ? "json" : undefined);
            if (readFileBytes && nativeLoader)
              return {
                contents: await readFileBytes(args.path),
                loader: nativeLoader,
                resolveDir: dirname(args.path)
              };

            return undefined;
          }

          const contents = await readFile(args.path);

          return {
            contents: transformScopedDependencySource({
              contents,
              filePath: args.path,
              loader,
              rootPath: build.initialOptions.absWorkingDir!,
              packageName
            }),
            loader,
            resolveDir: dirname(args.path)
          };
        }
      );
    }
  };
}

function scopeLoadedDependencies(plugin: Plugin, packageName: string): Plugin {
  return {
    ...plugin,
    setup(build) {
      return plugin.setup({
        ...build,
        onLoad(options, callback) {
          build.onLoad(options, async (args) => {
            const result = await callback(args);
            if (
              args.namespace !== "file" ||
              result?.contents === undefined ||
              result.errors?.length
            ) {
              return result;
            }

            // esbuild defaults plugin-provided contents to JS, regardless of
            // the extension's configured loader.
            const loader = result.loader ?? "js";
            if (
              loader !== "js" &&
              loader !== "jsx" &&
              loader !== "ts" &&
              loader !== "tsx"
            ) {
              return result;
            }

            return {
              ...result,
              contents: transformScopedDependencySource({
                contents:
                  typeof result.contents === "string"
                    ? result.contents
                    : Buffer.from(result.contents).toString("utf8"),
                filePath: args.path,
                loader,
                rootPath: build.initialOptions.absWorkingDir!,
                packageName
              })
            };
          });
        }
      });
    }
  };
}

function assertSingleChildCompilationOutput(
  outputFiles?: Array<{ text: string }>
) {
  if (!outputFiles || outputFiles.length !== 1) {
    throw new Error("Invalid child compilation result");
  }

  return outputFiles[0].text;
}

function getWatchFiles(
  cwd: string,
  metafile?: { inputs?: Record<string, unknown> }
) {
  return [
    ...new Set(
      Object.keys(metafile?.inputs || {}).map((filePath) =>
        resolve(cwd, internalStripStaticCssEvalRequestQuery(filePath))
      )
    )
  ];
}

export async function compile({
  esbuild = defaultEsbuild,
  filePath,
  contents,
  cwd = process.cwd(),
  externals = [],
  loader,
  plugins = [],
  readFile,
  readFileBytes,
  resolverCache = new Map(),
  originalPath
}: CompileOptions) {
  const packageInfo = getPackageInfo(cwd);
  const sourcePackageInfo = getPackageInfo(dirname(originalPath));
  const source = getScopedSourceWithCache({
    contents,
    originalPath,
    packageName: sourcePackageInfo.name,
    rootPath: sourcePackageInfo.dirname,
    resolverCache
  });

  const result = await esbuild.build({
    stdin: {
      contents: source,
      loader: "tsx",
      resolveDir: dirname(filePath),
      sourcefile: basename(filePath)
    },
    metafile: true,
    bundle: true,
    external: ["@vanilla-extract", "@mincho-js/css", ...externals],
    platform: "node",
    write: false,
    absWorkingDir: cwd,
    loader,
    plugins: [
      ...plugins.map((plugin) =>
        scopeLoadedDependencies(plugin, packageInfo.name)
      ),
      createScopedOnLoadPlugin(
        packageInfo.name,
        loader,
        readFile,
        readFileBytes
      )
    ]
  });

  const compiledSource = assertSingleChildCompilationOutput(result.outputFiles);

  return {
    source: compiledSource,
    watchFiles: getWatchFiles(cwd, result.metafile)
  };
}

// @ts-expect-error error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createChildEsbuildStub(
    options: {
      metafileInputs?: Record<string, unknown>;
      outputFiles?: Array<{ text: string }>;
      onLoadPath?: string;
    } = {}
  ) {
    const buildCalls: Array<BuildOptions> = [];

    const esbuild = {
      async build(buildOptions: BuildOptions) {
        buildCalls.push(buildOptions);

        const onLoadHandlers: Array<{
          callback: (args: { path: string }) => Promise<{ contents: string }>;
        }> = [];

        const pluginBuild = {
          initialOptions: {
            absWorkingDir: buildOptions.absWorkingDir
          },

          onLoad(
            _options: unknown,
            callback: (args: { path: string }) => Promise<{ contents: string }>
          ) {
            onLoadHandlers.push({ callback });
          }
        };

        for (const plugin of buildOptions.plugins ?? []) {
          plugin.setup(pluginBuild as PluginBuild);
        }

        if (onLoadHandlers[0]) {
          await onLoadHandlers[0].callback({
            path: options.onLoadPath ?? "/workspace/scoped-dependency.tsx"
          });
        }

        return {
          outputFiles: options.outputFiles ?? [
            { text: buildOptions.stdin!.contents! }
          ],
          metafile: { inputs: options.metafileInputs ?? {} }
        };
      }
    };

    return { buildCalls, esbuild: esbuild as PluginBuild["esbuild"] };
  }

  describe("compile", () => {
    it("compile reuses resolver cache and returns watch files", async () => {
      vi.spyOn(fs.promises, "readFile").mockResolvedValue(
        'export const child = "ok";'
      );

      const { buildCalls, esbuild } = createChildEsbuildStub({
        metafileInputs: {
          "src/dependency.tsx": {},
          "src/dependency.tsx?url#asset": {},
          "nested/child.ts": {},
          [resolve(process.cwd(), "nested/child.ts")]: {}
        }
      });

      const resolverCache = new Map<string, string>();
      const cwd = process.cwd();
      const originalPath = `${cwd}/source.css.ts`;

      const first = await compile({
        esbuild,
        filePath: `${cwd}/child.tsx`,
        contents: "export const one = 1;",
        cwd,
        resolverCache,
        originalPath
      });

      const second = await compile({
        esbuild,
        filePath: `${cwd}/child.tsx`,
        contents: "export const two = 2;",
        cwd,
        resolverCache,
        originalPath
      });

      expect(buildCalls).toHaveLength(2);
      expect(buildCalls[0]!.stdin!.contents).toBe(
        buildCalls[1]!.stdin!.contents
      );
      expect(first.source).toBe(second.source);
      expect(resolverCache.get(originalPath)).toBe(first.source);
      expect(first.watchFiles).toEqual([
        join(cwd, "src/dependency.tsx"),
        join(cwd, "nested/child.ts")
      ]);
    });

    it.each(["dependency.component", "dependency.custom.ts"])(
      "uses the configured loader for scoped %s dependencies",
      async (name: string) => {
        vi.spyOn(fs.promises, "readFile").mockResolvedValue(
          "export const child = <div />;"
        );

        const cwd = process.cwd();
        const { esbuild } = createChildEsbuildStub({
          onLoadPath: join(cwd, name)
        });

        const compiled = await compile({
          esbuild,
          filePath: join(cwd, "child.tsx"),
          originalPath: join(cwd, "source.css.ts"),
          contents: "export const value = 1;",
          resolverCache: new Map(),
          loader: { ".component": "jsx", ".custom.ts": "jsx" }
        });

        expect(compiled.source).toContain("export const value = 1;");
      }
    );

    it("compile throws Invalid child compilation result", async () => {
      vi.spyOn(fs.promises, "readFile").mockResolvedValue(
        'export const child = "ok";'
      );

      const { esbuild } = createChildEsbuildStub({
        outputFiles: []
      });

      const cwd = process.cwd();

      await expect(
        compile({
          esbuild,
          filePath: `${cwd}/child.tsx`,
          contents: "export const value = 1;",
          cwd,
          resolverCache: new Map(),
          originalPath: `${cwd}/source.css.ts`
        })
      ).rejects.toThrow("Invalid child compilation result");
    });
  });
}
