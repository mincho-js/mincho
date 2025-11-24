/**
 * Mincho Vite Plugin - Babel Implementation
 */

import type { BabelOptions } from "@mincho-js/integration";
import { babelTransform, compile } from "@mincho-js/integration";
import { processVanillaFile } from "@vanilla-extract/integration";
import { normalizePath } from "@rollup/pluginutils";
import { join, resolve } from "node:path";
import * as fs from "node:fs";
import type {
  Plugin,
  PluginContext,
  ResolvedConfig,
  ViteDevServer
} from "./types.js";
import { extractedCssFileFilter, customNormalize } from "./utils.js";

export function minchoBabelVitePlugin(_options?: {
  babel?: BabelOptions;
}): Plugin {
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
  };
}
