// @ts-check

import { readdirSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";

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

  if (ViteEnv.isProd()) {
    plugins.add(
      // This is currently a proprietary implementation. You might also like to see
      // https://github.com/qmhc/vite-plugin-dts/issues/267
      dts({
        entryRoot: resolve(process.cwd(), "src/"),
        include: ["src"],
        outDir: "./dist/esm"
      }),
      dts({
        entryRoot: resolve(process.cwd(), "src/"),
        include: ["src"],
        outDir: "./dist/cjs",
        compilerOptions: {
          module: ModuleKind.CommonJS,
          outDir: "./dist/cjs",
          declarationDir: "./dist/cjs"
        },
        afterBuild: () => {
          // Rename the CommonJS declaration file to .d.cts
          const cjsDir = resolve(process.cwd(), "dist/cjs");
          readdirSync(cjsDir).forEach((file) => {
            if (file.endsWith(".d.ts")) {
              renameSync(
                join(cjsDir, file),
                join(cjsDir, file.replace(".d.ts", ".d.cts"))
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
          index: resolve(process.cwd(), "src/index.ts")
        },
        formats: ["es", "cjs"],
        fileName: (format, entryName) =>
          `${format === "es" ? "esm" : "cjs"}/${entryName}.${format === "es" ? "mjs" : "cjs"}`
      },
      target: ["es2020"]
    },
    plugins: plugins.build()
  });
  return configs;
}

function initCommonBuilder(viteConfigEnv) {
  const configs = initConfigBuilder(viteConfigEnv);

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

  if (ViteEnv.isProd()) {
    configs.add({
      build: {
        sourcemap: false,
        minify: false
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
