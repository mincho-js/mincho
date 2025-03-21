import { addFileScope, getPackageInfo } from "@vanilla-extract/integration";
import defaultEsbuild, { PluginBuild } from "esbuild";
import { transformSync } from "@babel/core";
import { basename, dirname, join } from "path";
import * as fs from "fs";
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
  let source: string;

  if (resolverCache.has(originalPath)) {
    source = resolverCache.get(originalPath)!;
  } else {
    source = addFileScope({
      source: contents,
      filePath: originalPath,
      rootPath: cwd,
      packageName: packageInfo.name
    });

    resolverCache.set(originalPath, source);
  }

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
    plugins: [
      {
        name: "mincho:custom-extract-scope",
        setup(build) {
          build.onLoad({ filter: /\.(t|j)sx?$/ }, async (args) => {
            const contents = await fs.promises.readFile(args.path, "utf-8");
            let source = addFileScope({
              source: contents,
              filePath: args.path,
              rootPath: build.initialOptions.absWorkingDir!,
              packageName: packageInfo.name
            });

            source = transformSync(source, {
              filename: args.path,
              plugins: [minchoStyledComponentPlugin()],
              presets: ["@babel/preset-typescript"],
              sourceMaps: false
            })!.code!;

            return {
              contents: source,
              loader: "tsx",
              resolveDir: dirname(args.path)
            };
          });
        }
      }
    ]
  });

  const { outputFiles, metafile } = result;

  if (!outputFiles || outputFiles.length !== 1) {
    throw new Error("Invalid child compilation result");
  }

  return {
    source: outputFiles[0].text,
    watchFiles: Object.keys(metafile?.inputs || {}).map((filePath) =>
      join(cwd, filePath)
    )
  };
}
