import { dirname, join } from "node:path";
import { processVanillaFile } from "@vanilla-extract/integration";
import { vanillaExtractPlugin } from "@vanilla-extract/esbuild-plugin";
import { Plugin as EsbuildPlugin } from "esbuild";
import { babelTransform, compile } from "@mincho-js/integration";

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
          const { source } = await compile({
            esbuild: build.esbuild,
            filePath: path,
            originalPath: pluginData.mainFilePath!,
            contents: resolverContents,
            externals: [],
            cwd: build.initialOptions.absWorkingDir,
            resolverCache
          });

          try {
            const contents = await processVanillaFile({
              source,
              filePath: path,
              outputCss: undefined,
              identOption: build.initialOptions.minify ? "short" : "debug"
            });

            return {
              contents,
              loader: "js",
              resolverDir: dirname(path)
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
        } = await babelTransform(args.path);

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
