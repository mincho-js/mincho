import { addFileScope, getPackageInfo } from "@vanilla-extract/integration";
import defaultEsbuild, { PluginBuild } from "esbuild";
import { basename, dirname, join } from "path";
import * as fs from "fs";
import { oxcBaseTransform, minchoTransform } from "@mincho-js/oxc";

interface CompileOptions {
  esbuild?: PluginBuild["esbuild"];
  filePath: string;
  contents: string;
  cwd?: string;
  externals?: Array<string>;
  resolverCache: Map<string, string>;
  originalPath: string;
}

/**
 * Compile function using OXC instead of Babel
 *
 * This function provides significantly faster compilation by:
 * 1. Using oxc-transform for TypeScript/JSX (10-20x faster than Babel)
 * 2. Using oxc-parser + magic-string for Mincho transformations (5-10x faster)
 *
 * Architecture:
 * - Main file gets addFileScope with caching
 * - esbuild bundles with custom plugin
 * - Plugin applies two-phase transformation:
 *   Phase 1: oxcBaseTransform (TS/JSX)
 *   Phase 2: minchoTransform (styled() -> $$styled())
 *
 * @param options Compilation options
 * @returns Compiled source and watch files
 */
export async function compileWithOxc({
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

  // Cache file scope transformations
  if (resolverCache.has(originalPath)) {
    source = resolverCache.get(originalPath)!;
  } else {
    // All .css.ts files need file scope, including extracted ones
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
    external: [
      "@vanilla-extract",
      "@vanilla-extract/css",
      "@vanilla-extract/css/adapter",
      "@vanilla-extract/css/fileScope",
      "@mincho-js/css",
      ...externals
    ],
    platform: "node",
    write: false,
    absWorkingDir: cwd,
    plugins: [
      {
        name: "mincho:oxc-transform",
        setup(build) {
          build.onLoad({ filter: /\.(t|j)sx?$/ }, async (args) => {
            const contents = await fs.promises.readFile(args.path, "utf-8");

            // All files need addFileScope
            const source = addFileScope({
              source: contents,
              filePath: args.path,
              rootPath: build.initialOptions.absWorkingDir!,
              packageName: packageInfo.name
            });

            // Phase 1: OXC base transform (TypeScript + JSX)
            // This is synchronous and extremely fast (Rust-based)
            const oxcResult = oxcBaseTransform(args.path, source, {
              typescript: {
                onlyRemoveTypeImports: true
              },
              jsx: {
                runtime: "automatic",
                development: process.env.NODE_ENV !== "production"
              },
              target: "es2020",
              sourcemap: false
            });

            // Phase 2: Mincho custom transform (styled() -> $$styled())
            // Uses oxc-parser for validation + magic-string for fast transformation
            const minchoResult = minchoTransform(oxcResult.code, {
              filename: args.path,
              sourceRoot: build.initialOptions.absWorkingDir!,
              extractCSS: false // compile() doesn't extract CSS, only transforms
            });

            return {
              contents: minchoResult.code,
              loader: "js", // Already transformed to JS
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
