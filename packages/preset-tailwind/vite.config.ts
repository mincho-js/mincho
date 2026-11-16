import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ConfigEnv } from "vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { NodeConfig } from "vite-config-custom";

export default (env: ConfigEnv) => {
  const config = NodeConfig(env, {
    plugins: [
      vanillaExtractPlugin() as unknown as never,
      {
        name: "tailwind-preflight",
        generateBundle() {
          const sourcePath = resolve(import.meta.dirname, "src/preflight.css");

          this.emitFile({
            type: "asset",
            fileName: "preflight.css",
            originalFileName: sourcePath,
            source: readFileSync(sourcePath, "utf8")
          });
        }
      }
    ],
    build: {
      cssCodeSplit: false,
      lib: {
        entry: Object.fromEntries(
          ["index", "tokens", "config"].map((name) => [
            name,
            resolve(import.meta.dirname, `src/${name}.ts`)
          ])
        ),
        cssFileName: "styles"
      }
    }
  });

  // Keep build-time authoring separate from theme data so unused authoring
  // exports cannot pull the style compiler into browser bundles.
  const outputs = config.build?.rollupOptions?.output;

  if (Array.isArray(outputs)) {
    for (const output of outputs) {
      output.preserveModules = true;
      output.preserveModulesRoot = resolve(import.meta.dirname, "src");
    }
  }

  return config;
};
