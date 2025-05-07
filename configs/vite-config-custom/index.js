// @ts-check

import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { cwd, env } from "node:process";

import { PromisePool } from "@supercharge/promise-pool";
import { initConfigBuilder, ViteEnv, PluginBuilder } from "vite-config-builder";
import { mergeConfig } from "vite";

import { ModuleKind, ModuleResolutionKind } from "typescript";
import { externalizeDeps } from "vite-plugin-externalize-deps";
import tsconfigPaths from "vite-tsconfig-paths";
import { dts } from "vite-plugin-dts-build";

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
  const cacheEsmDir = resolve(packageRoot, ".cache", "typescript", "esm");
  const cacheCjsDir = resolve(packageRoot, ".cache", "typescript", "cjs");
  const outEsmDir = resolve(packageRoot, "dist", "esm");
  const outCjsDir = resolve(packageRoot, "dist", "cjs");

  const runtimeEnv = getRuntimeEnv();
  if (ViteEnv.isProd()) {
    if (runtimeEnv === "LOCAL" || runtimeEnv === "PUBLISH") {
      plugins.add(
        // This is currently a proprietary implementation. You might also like to see
        // https://github.com/qmhc/vite-plugin-dts/issues/267
        dts({
          include: ["src"],
          cacheDir: cacheEsmDir,
          outDir: outEsmDir,
          tsconfigPath: resolve(packageRoot, "tsconfig.lib.json")
        })
      );
    }
    if (runtimeEnv === "PUBLISH") {
      plugins.add(
        dts({
          include: ["src"],
          cacheDir: cacheCjsDir,
          outDir: outCjsDir,
          tsconfigPath: resolve(packageRoot, "tsconfig.lib.json"),
          compilerOptions: {
            module: ModuleKind.CommonJS,
            moduleResolution: ModuleResolutionKind.Node10,
            outDir: outCjsDir,
            declarationDir: outCjsDir,
            tsBuildInfoFile: resolve(
              packageRoot,
              ".cache",
              "typescript",
              "tsbuildinfo-cjs"
            )
          },
          afterBuild: async () => {
            // Rename the CommonJS declaration file to .d.cts
            await renameDeclarationFiles(outCjsDir);
          }
        })
      );
    }
    plugins.add(externalizeDeps());
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

async function renameDeclarationFiles(dir) {
  try {
    const allFiles = await collectDeclarationFiles(dir);

    if (allFiles.length === 0) {
      return;
    }
    console.log(`Processing ${allFiles.length} declaration files...`);

    const { errors } = await PromisePool.for(allFiles)
      .withConcurrency(10)
      .process(processCtsFile);

    if (errors.length > 0) {
      console.error(`${errors.length} files failed to process`);
    }
  } catch (error) {
    console.error(`Error processing: ${error.message}`);
  }
}

async function collectDeclarationFiles(dir, fileList = []) {
  try {
    const fileOrDirs = await readdir(dir, { withFileTypes: true });
    const subDirectories = [];

    for (const fileOrDir of fileOrDirs) {
      const fullPath = join(dir, fileOrDir.name);

      if (fileOrDir.isDirectory()) {
        subDirectories.push(fullPath);
      } else if (fileOrDir.name.endsWith(".d.ts")) {
        fileList.push(fullPath);
      }
    }

    if (subDirectories.length > 0) {
      await PromisePool.for(subDirectories)
        .withConcurrency(8)
        .process(async (subDir) => {
          await collectDeclarationFiles(subDir, fileList);
        });
    }

    return fileList;
  } catch (error) {
    console.error(`Error reading directory ${dir}: ${error.message}`);
    return fileList;
  }
}

async function processCtsFile(fullPath) {
  // Change import paths from .js to .cjs
  const content = await readFile(fullPath, "utf8");
  const importRegex = /from ['"](.+)\.js['"];?$/gm;
  const modifiedContent = content.replace(importRegex, "from '$1.cjs'");

  // Change file extension from .d.ts to .d.cts
  const newPath = fullPath.replace(".d.ts", ".d.cts");
  await writeFile(newPath, modifiedContent, "utf8");
  await unlink(fullPath);
}

function getRuntimeEnv() {
  if (env["PACKAGE_PUBLISH"] === "true") {
    return "PUBLISH";
  }

  if (env["GITHUB_ACTIONS"] === "true") {
    return "ACTIONS";
  }
  return "LOCAL";
}
