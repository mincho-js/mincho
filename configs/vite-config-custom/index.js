// @ts-check

import { readdirSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { cwd } from "node:process";

import { initConfigBuilder, ViteEnv, PluginBuilder } from "vite-config-builder";
import { mergeConfig } from "vite";

import { ModuleKind } from "typescript";
import { externalizeDeps } from "vite-plugin-externalize-deps";
import tsconfigPaths from "vite-tsconfig-paths";
import dts from "vite-plugin-dts";

// == Main Configs ============================================================
export function NodeConfig(viteConfigEnv, extendConfigs = {}) {
  return buildConfig(viteConfigEnv, extendConfigs, NodeBuilder);
}

function buildConfig(viteConfigEnv, extendConfigs, configBuilder) {
  return mergeConfig(
    {
      ...configBuilder(viteConfigEnv).build()
    },
    extendConfigs
  );
}

// == Main Configs ============================================================
function NodeBuilder(viteConfigEnv) {
  const { configs, plugins } = initCommonBuilder(viteConfigEnv);
  const packageRoot = cwd();
  const entryRoot = resolve(packageRoot, "src");
  const entryFile = resolve(entryRoot, "index.ts");
  const outEsmDir = resolve(packageRoot, "dist", "esm");
  const outCjsDir = resolve(packageRoot, "dist", "cjs");

  if (ViteEnv.isProd()) {
    plugins.add(
      // This is currently a proprietary implementation. You might also like to see
      // https://github.com/qmhc/vite-plugin-dts/issues/267
      dts({
        entryRoot,
        include: ["src"],
        outDir: outEsmDir,
        tsconfigPath: resolve(packageRoot, "tsconfig.lib.json")
      }),
      dts({
        entryRoot,
        include: ["src"],
        outDir: outCjsDir,
        tsconfigPath: resolve(packageRoot, "tsconfig.lib.json"),
        compilerOptions: {
          module: ModuleKind.CommonJS,
          outDir: outCjsDir,
          declarationDir: outCjsDir,
          tsBuildInfoFile: resolve(
            packageRoot,
            ".cache",
            "typescript",
            "tsbuildinfo-cjs"
          )
        },
        afterBuild: () => {
          // Rename the CommonJS declaration file to .d.cts
          readdirSync(outCjsDir).forEach((file) => {
            if (file.endsWith(".d.ts")) {
              renameSync(
                join(outCjsDir, file),
                join(outCjsDir, file.replace(".d.ts", ".d.cts"))
              );
            }
          });
        }
      }),
      externalizeDeps()
    );
  }

  if (ViteEnv.isTest()) {
    plugins.add({
      name: "extend-import-meta-debuglog",
      transform(code, id) {
        const excludedPackages = ["debug-log"];
        const isExcluded = excludedPackages.some((pkg) => id.includes(pkg));

        if (!isExcluded && (id.endsWith(".js") || id.endsWith(".ts"))) {
          return {
            code: `
              import * as debugLog from "@mincho-js/debug-log";
              if (!import.meta.debugLog) {
                import.meta.debugLog = debugLog;
              }
              ${code}
            `,
            map: null
          };
        }
      }
    });
  } else {
    configs.add({
      define: {
        "import.meta.debugLog": "undefined"
      }
    });
  }

  configs.add({
    build: {
      // https://vitejs.dev/guide/build.html#library-mode
      lib: {
        entry: {
          index: entryFile
        },
        formats: ["es", "cjs"],
        fileName: (format, entryName) =>
          `${format === "es" ? "esm" : "cjs"}/${entryName}.${format === "es" ? "mjs" : "cjs"}`
      },
      target: ["es2020"],
      minify: false
    },
    plugins: plugins.build()
  });
  return configs;
}

function initCommonBuilder(viteConfigEnv) {
  const configs = initConfigBuilder(viteConfigEnv);

  configs.add({
    cacheDir: join(".cache", "vite")
  });

  if (ViteEnv.isDev()) {
    configs.add({
      build: {
        sourcemap: true,
        minify: false,
        rollupOptions: {
          treeshake: false
        }
      }
    });
  }

  if (ViteEnv.isTest()) {
    configs.add({
      test: {
        includeSource: ["src/**/*.ts", "src/**/*.tsx"],
        globals: true
      }
    });
  } else {
    configs.add({
      define: {
        "import.meta.vitest": "undefined"
      }
    });
  }

  const plugins = new PluginBuilder([tsconfigPaths()]);

  return {
    configs,
    plugins
  };
}
