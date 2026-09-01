import { typescriptPresetPath } from "./babelPreset.js";
import { basename, dirname, join } from "node:path";
import * as fs from "node:fs";
import { addFileScope, getPackageInfo } from "@vanilla-extract/integration";
import defaultEsbuild, { type BuildOptions, type PluginBuild } from "esbuild";
import { transformSync } from "@babel/core";
import { minchoStyledComponentPlugin } from "@mincho-js/babel";

interface CompileOptions {
  esbuild?: PluginBuild["esbuild"];
  filePath: string;
  contents: string;
  cwd?: string;
  externals?: Array<string>;
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
  packageName,
  rootPath
}: {
  contents: string;
  filePath: string;
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
    plugins: [minchoStyledComponentPlugin()],
    presets: [typescriptPresetPath],
    sourceMaps: false
  })!.code!;

  return source;
}

function createScopedOnLoadPlugin(packageName: string) {
  return {
    name: "mincho:custom-extract-scope",
    setup(build: PluginBuild) {
      build.onLoad(
        { filter: /\.(t|j)sx?$/ },
        async (args: { path: string }) => {
          const contents = await fs.promises.readFile(args.path, "utf-8");

          return {
            contents: transformScopedDependencySource({
              contents,
              filePath: args.path,
              rootPath: build.initialOptions.absWorkingDir!,
              packageName
            }),
            loader: "tsx",
            resolveDir: dirname(args.path)
          };
        }
      );
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
  return Object.keys(metafile?.inputs || {}).map((filePath) =>
    join(cwd, filePath)
  );
}

export async function compile({
  esbuild = defaultEsbuild,
  filePath,
  contents,
  cwd = process.cwd(),
  externals = [],
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
    plugins: [createScopedOnLoadPlugin(packageInfo.name)]
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
          "nested/child.ts": {}
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
