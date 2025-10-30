/**
 * Mincho Vite Plugin - OXC Implementation
 */

import { compileWithOxc, oxcTransformFile } from "@mincho-js/integration";
import type { MinchoOxcBaseOptions } from "@mincho-js/oxc";
import { normalizePath } from "@rollup/pluginutils";
import { processVanillaFile } from "@vanilla-extract/integration";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import type {
  Plugin,
  PluginContext,
  ResolvedConfig,
  ViteDevServer
} from "./types.js";
import { extractedCssFileFilter, customNormalize } from "./utils.js";

/**
 * Options for Mincho OXC Vite Plugin
 */
export interface MinchoOxcVitePluginOptions {
  include?: string | string[];
  exclude?: string | string[];
  oxc?: MinchoOxcBaseOptions;
  mincho?: {
    extractCSS?: boolean;
    virtualModulePrefix?: string;
  };
}

/**
 * Mincho Vite Plugin with OXC
 *
 * Architecture:
 * 1. OXC handles TS/JSX transpilation (via base transform)
 * 2. Custom Mincho transform handles styled(), style(), css() (via mincho transform)
 * 3. Virtual CSS modules registered with Vite
 *
 * This replaces Babel with OXC for 10-15x faster build performance
 */
export function minchoOxcVitePlugin(
  _options?: MinchoOxcVitePluginOptions
): Plugin {
  let config: ResolvedConfig;
  let server: ViteDevServer;
  const cssMap = new Map<string, string>();
  const resolverCache = new Map<string, string>();
  const resolvers = new Map<string, string>();
  const idToPluginData = new Map<string, Record<string, string>>();
  const virtualExt = ".vanilla.css";

  return {
    name: "mincho-css-vite-oxc",
    enforce: "pre",
    buildStart() {
      // Clear caches on build start
      resolvers.clear();
      resolverCache.clear();
      cssMap.clear();
      idToPluginData.clear();
    },
    configureServer(serverInstance: ViteDevServer) {
      server = serverInstance;
    },
    async configResolved(resolvedConfig: ResolvedConfig) {
      config = resolvedConfig;
    },
    resolveId(id: string, importer?: string) {
      if (id.startsWith("\0")) return;

      // Handle extracted CSS files
      if (extractedCssFileFilter(id)) {
        const normalizedId = id.startsWith("/") ? id.slice(1) : id;
        const resolvedPath = normalizePath(join(importer!, "..", normalizedId));

        if (!resolvers.has(resolvedPath)) {
          return;
        }
        return resolvedPath;
      }

      // Handle virtual CSS modules
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

      // Handle extracted CSS file loads
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
          originalPath: id // Use the extracted file path itself as originalPath
        });

        return resolverContents;
      }

      // Handle virtual CSS module loads
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

      // Handle extracted CSS file transformations
      if (
        moduleInfo &&
        moduleInfo.originalPath &&
        moduleInfo.filePath &&
        extractedCssFileFilter(id)
      ) {
        try {
          const { source, watchFiles } = await compileWithOxc({
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

          const contents = await processVanillaFile({
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
          console.error(error);
        }
      }

      // Handle JS/TS/JSX/TSX files (but not .css.ts or node_modules)
      if (/(j|t)sx?(\?used)?$/.test(id) && !id.endsWith(".vanilla.js")) {
        if (id.includes("node_modules")) return;

        // Skip .css.ts files EXCEPT extracted ones (they need processing)
        if (id.endsWith(".css.ts") && !id.includes("extracted_")) return;

        // Skip already transformed dist files
        const cleanId = id.split("?")[0];
        if (cleanId.includes("/dist/")) return;

        try {
          await fs.promises.access(id, fs.constants.F_OK);
        } catch {
          return;
        }

        // Use OXC transformation
        const {
          code: transformedCode,
          result: [file, cssExtract],
          cssExtractions
        } = await oxcTransformFile(id, {
          oxc: _options?.oxc,
          mincho: {
            extractCSS: _options?.mincho?.extractCSS ?? true
          },
          cwd: config.root
        });

        // Register all CSS extractions as virtual modules
        if (cssExtractions && cssExtractions.length > 0) {
          for (const extraction of cssExtractions) {
            const resolvedCssPath = normalizePath(
              join(id, "..", extraction.id)
            );
            resolvers.set(resolvedCssPath, extraction.content);

            const normalizedCssPath = customNormalize(resolvedCssPath);
            idToPluginData.set(normalizedCssPath, {
              mainFilePath: id,
              path: resolvedCssPath,
              filePath: resolvedCssPath,
              originalPath: resolvedCssPath
            });
          }
        }

        if (!cssExtract || !file) {
          // No CSS extraction, return transformed code directly
          return {
            code: transformedCode,
            map: { mappings: "" }
          };
        }

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
          code: transformedCode,
          map: { mappings: "" }
        };
      }
      return null;
    }
  };
}
