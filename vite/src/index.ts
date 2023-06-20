import {
  babelTransform,
  compile,
  BabelOptions,
} from '@macaron-css/integration';
import { processVanillaFile } from '@vanilla-extract/integration';
import fs from 'fs';
import { join, resolve } from 'path';
import {
  normalizePath,
  PluginOption,
  ResolvedConfig,
  ViteDevServer,
} from 'vite';

const extractedCssFileFilter = /extracted_(.*)\.css\.ts(\?used)?$/;

export function macaronVitePlugin(options?: {
  babel?: BabelOptions;
}): PluginOption {
  let config: ResolvedConfig;
  let server: ViteDevServer;
  const cssMap = new Map<string, string>();
  const resolverCache = new Map<string, string>();
  const resolvers = new Map<string, string>();
  const idToPluginData = new Map<string, Record<string, string>>();

  const virtualExt = '.vanilla.css';

  return {
    name: 'macaron-css-vite',
    enforce: 'pre',
    buildStart() {
      // resolvers.clear();
      // idToPluginData.clear();
      // resolverCache.clear();
      // cssMap.clear();
    },
    configureServer(_server) {
      server = _server;
    },
    async configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    resolveId(id, importer, options) {
      if (id.startsWith('\0')) return;

      if (extractedCssFileFilter.test(id)) {
        const normalizedId = id.startsWith('/') ? id.slice(1) : id;
        let resolvedPath = normalizePath(join(importer!, '..', normalizedId));

        if (!resolvers.has(resolvedPath)) {
          return;
        }

        return resolvedPath;
      }

      if (id.endsWith(virtualExt)) {
        const normalizedId = id.startsWith('/') ? id.slice(1) : id;

        const key = normalizePath(resolve(config.root, normalizedId));
        if (cssMap.has(key)) {
          return key;
        }
      }
    },
    async load(id, options) {
      if (id.startsWith('\0')) return;

      if (extractedCssFileFilter.test(id)) {
        let normalizedId = customNormalize(id);
        let pluginData = idToPluginData.get(normalizedId);

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
          originalPath: pluginData.mainFilePath,
        });

        return resolverContents;
      }

      if (id.endsWith(virtualExt)) {
        const cssFileId = normalizePath(resolve(config.root, id));
        const css = cssMap.get(cssFileId);

        if (typeof css !== 'string') {
          return;
        }

        return css;
      }
    },
    async transform(code, id, ssrParam) {
      if (id.startsWith('\0')) return;

      const moduleInfo = idToPluginData.get(id);

      let ssr: boolean | undefined;

      if (typeof ssrParam === 'boolean') {
        ssr = ssrParam;
      } else {
        ssr = ssrParam?.ssr;
      }

      // is returned from extracted_HASH.css.ts
      if (
        moduleInfo &&
        moduleInfo.originalPath &&
        moduleInfo.filePath &&
        extractedCssFileFilter.test(id)
      ) {
        const { source, watchFiles } = await compile({
          filePath: moduleInfo.filePath,
          cwd: config.root,
          originalPath: moduleInfo.originalPath,
          contents: code,
          resolverCache,
          externals: [],
        });

        for (const file of watchFiles) {
          if (extractedCssFileFilter.test(file)) {
            continue;
          }
          // In start mode, we need to prevent the file from rewatching itself.
          // If it's a `build --watch`, it needs to watch everything.
          if (config.command === 'build' || file !== id) {
            this.addWatchFile(file);
          }
        }

        try {
          const contents = await processVanillaFile({
            source,
            filePath: moduleInfo.filePath,
            identOption:
              undefined ?? (config.mode === 'production' ? 'short' : 'debug'),
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
            },
          });

          return contents;
        } catch (error) {
          throw error;
        }
      }

      if (/(j|t)sx?(\?used)?$/.test(id) && !id.endsWith('.vanilla.js')) {
        if (id.includes('node_modules')) return;

        // gets handled by @vanilla-extract/vite-plugin
        if (id.endsWith('.css.ts')) return;

        try {
          await fs.promises.access(id, fs.constants.F_OK);
        } catch {
          // probably a virtual file, to be handled by other plugin
          return;
        }

        const {
          code,
          result: [file, cssExtract],
        } = await babelTransform(id, options?.babel);

        if (!cssExtract || !file) return null;

        if (config.command === 'build' && config.build.watch) {
          this.addWatchFile(id);
        }

        let resolvedCssPath = normalizePath(join(id, '..', file));

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
          mainFilePath: id,
        });
        idToPluginData.set(normalizedCssPath, {
          ...idToPluginData.get(normalizedCssPath),
          mainFilePath: id,
          path: resolvedCssPath,
        });

        return {
          code,
          map: { mappings: '' },
        };
      }

      return null;
    },
  };
}

function customNormalize(path: string) {
  return path.startsWith('/') ? path.slice(1) : path;
}
