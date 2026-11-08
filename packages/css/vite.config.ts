import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { normalizePath, transformWithEsbuild } from "vite";
import type { ConfigEnv, Plugin } from "vite";
import { NodeConfig } from "vite-config-custom";
import { layoutCss } from "./src/layout/stylesheet.js";

// == Vite Config =============================================================
// https://vitejs.dev/config/#build-lib
export default (viteConfigEnv: ConfigEnv) => {
  const packageDir = process.cwd();
  const config = NodeConfig(viteConfigEnv, {
    plugins: [pureRuntimeBoundaries(), selectorNamespace(packageDir)],
    build: {
      lib: {
        entry: {
          index: join(packageDir, "src", "index.ts"),
          compat: join(packageDir, "src", "compat.ts"),
          "layout/index": join(packageDir, "src/layout/index.ts"),
          "layout/core": join(packageDir, "src/layout/core.ts"),
          "squircle/index": join(packageDir, "src/squircle/index.ts"),
          "squircle/core": join(packageDir, "src/squircle/core.ts"),
          ...Object.fromEntries(
            [
              "position",
              "quantity",
              "logical",
              "compose",
              "pseudo",
              "children"
            ].map((name) => [
              `selectors/${name}`,
              join(packageDir, `src/selectors/${name}.ts`)
            ])
          ),
          "runtime/classname": join(packageDir, "src", "classname", "index.ts"),
          "defineRules/createDefineRulesCssRuntime": join(
            packageDir,
            "src",
            "defineRules",
            "createDefineRulesCssRuntime.ts"
          ),
          "defineRules/createDefineRulesRulesRuntime": join(
            packageDir,
            "src/defineRules/createDefineRulesRulesRuntime.ts"
          ),
          "runtime/createDefineRulesCxRuntime": join(
            packageDir,
            "src",
            "defineRules",
            "createDefineRulesCxRuntime.ts"
          ),
          "defineRules/registry": join(
            packageDir,
            "src",
            "defineRules",
            "registry.ts"
          ),
          "runtime/createClassRuntimeFn": join(
            packageDir,
            "src",
            "rules",
            "createClassRuntimeFn.ts"
          ),
          "runtime/createCompactRuntimeFn": join(
            packageDir,
            "src/rules/createCompactRuntimeFn.ts"
          ),
          "runtime/createPackedRuntimeFn": join(
            packageDir,
            "src/rules/createPackedRuntimeFn.ts"
          ),
          "runtime/createPackedCompactRuntimeFn": join(
            packageDir,
            "src/rules/createPackedCompactRuntimeFn.ts"
          ),
          "runtime/mapVarProps": join(
            packageDir,
            "src",
            "rules",
            "mapVarProps.ts"
          ),
          "runtime/createRuntimeFn": join(
            packageDir,
            "src",
            "rules",
            "createRuntimeFn.ts"
          )
        }
      }
    }
  });

  // Vite concatenates output arrays when merging configs; replace the defaults.
  config.build!.rollupOptions!.output = ["es", "cjs"].map((format) => ({
    format: format as "es" | "cjs",
    ...(format === "cjs" ? { interop: "compat" as const } : {}),
    onlyExplicitManualChunks: true,

    manualChunks(id: string) {
      if (/\/src\/selectors\/condition\.ts$/.test(id))
        return "selectors/condition";
      if (/\/src\/selectors\/syntax\.ts$/.test(id)) return "selectors/syntax";
      if (/\/src\/rules\/(?:createClassRuntimeFn)\.ts$/.test(id))
        return "runtime/recipes";
      if (/\/src\/rules\/(?:utils|runtimeProperties)\.ts$/.test(id))
        return "runtime/recipe-shared";
      if (/\/src\/classname\/cx\.ts$/.test(id)) return "runtime/classnames";
      if (/\/src\/runtime\/cache\.ts$/.test(id)) return "runtime/cache";
      if (/\/src\/defineRules\/createDefineRulesCxRuntime\.ts$/.test(id))
        return "runtime/conditions";
    },

    chunkFileNames: (chunk: { name: string }) =>
      /^(runtime|selectors)\//.test(chunk.name)
        ? `${format === "es" ? "esm" : "cjs"}/[name]-[hash].${format === "es" ? "mjs" : "cjs"}`
        : `[name]-[hash].${format === "es" ? "js" : "cjs"}`
  }));

  return config;
};

/** Rollup materializes re-exported namespaces as objects, retaining every method.
 * Transpile the two facades independently so consumers receive native ESM
 * namespace/re-export declarations and can discard unused pure modules.
 */
function selectorNamespace(packageDir: string): Plugin {
  return {
    name: "mincho-selector-namespace",
    apply: "build",
    enforce: "pre",
    buildStart() {
      for (const name of ["api", "index"])
        this.addWatchFile(join(packageDir, `src/selectors/${name}.ts`));
    },
    resolveId(source, importer) {
      if (
        importer === normalizePath(join(packageDir, "src/index.ts")) &&
        source === "./selectors/index.js"
      )
        return { id: "@mincho-js/css/selectors", external: true };
    },
    async generateBundle(output) {
      const esm = output.format === "es";
      for (const name of ["api", "index"]) {
        const filename = join(packageDir, `src/selectors/${name}.ts`);
        const source = (await readFile(filename, "utf8")).replace(
          /(from\s+["']\.[^"']*)\.js(["'])/g,
          `$1.${esm ? "mjs" : "cjs"}$2`
        );
        const result = await transformWithEsbuild(source, filename, {
          format: esm ? "esm" : "cjs",
          target: "es2020",
          sourcemap: false
        });
        this.emitFile({
          type: "asset",
          fileName: `${esm ? "esm" : "cjs"}/selectors/${name}.${esm ? "mjs" : "cjs"}`,
          source: result.code
        });
      }
    }
  };
}

/** Keep authoring and registry effects while allowing unused runtime code to disappear. */
function pureRuntimeBoundaries(): Plugin {
  return {
    name: "mincho-pure-runtime-boundaries",

    generateBundle(output) {
      this.emitFile({
        type: "asset",
        fileName: `${output.format === "es" ? "esm" : "cjs"}/selectors/package.json`,
        source: JSON.stringify({ sideEffects: false }) + "\n"
      });
      this.emitFile({
        type: "asset",
        fileName: `${output.format === "es" ? "esm" : "cjs"}/squircle/package.json`,
        source: JSON.stringify({ sideEffects: false }) + "\n"
      });
      this.emitFile({
        type: "asset",
        fileName: `${output.format === "es" ? "esm" : "cjs"}/layout/package.json`,
        source: JSON.stringify({ sideEffects: false }) + "\n"
      });
      if (output.format === "es")
        this.emitFile({
          type: "asset",
          fileName: "esm/layout.css",
          source: layoutCss
        });
      this.emitFile({
        type: "asset",
        fileName: `${output.format === "es" ? "esm" : "cjs"}/runtime/package.json`,
        source: JSON.stringify({ sideEffects: false }) + "\n"
      });
    }
  };
}
