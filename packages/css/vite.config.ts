import { join } from "node:path";
import type { ConfigEnv, Plugin } from "vite";
import { NodeConfig } from "vite-config-custom";

// == Vite Config =============================================================
// https://vitejs.dev/config/#build-lib
export default (viteConfigEnv: ConfigEnv) => {
  const packageDir = process.cwd();
  const config = NodeConfig(viteConfigEnv, {
    plugins: [pureRuntimeBoundaries()],
    build: {
      lib: {
        entry: {
          index: join(packageDir, "src", "index.ts"),
          compat: join(packageDir, "src", "compat.ts"),
          "runtime/classname": join(packageDir, "src", "classname", "index.ts"),
          "defineRules/createDefineRulesCssRuntime": join(
            packageDir,
            "src",
            "defineRules",
            "createDefineRulesCssRuntime.ts"
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
      if (/\/src\/rules\/(?:createRuntimeFn|utils)\.ts$/.test(id))
        return "runtime/recipes";
      if (/\/src\/classname\/cx\.ts$/.test(id)) return "runtime/classnames";
      if (/\/src\/defineRules\/createDefineRulesCxRuntime\.ts$/.test(id))
        return "runtime/conditions";
    },

    chunkFileNames: (chunk: { name: string }) =>
      chunk.name.startsWith("runtime/")
        ? `${format === "es" ? "esm" : "cjs"}/[name]-[hash].${format === "es" ? "mjs" : "cjs"}`
        : `[name]-[hash].${format === "es" ? "js" : "cjs"}`
  }));

  return config;
};

/** Keep authoring and registry effects while allowing unused runtime code to disappear. */
function pureRuntimeBoundaries(): Plugin {
  return {
    name: "mincho-pure-runtime-boundaries",

    generateBundle(output) {
      this.emitFile({
        type: "asset",
        fileName: `${output.format === "es" ? "esm" : "cjs"}/runtime/package.json`,
        source: JSON.stringify({ sideEffects: false }) + "\n"
      });
    }
  };
}
