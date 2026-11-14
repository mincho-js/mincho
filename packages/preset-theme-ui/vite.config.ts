import { resolve } from "node:path";
import type { ConfigEnv } from "vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { NodeConfig } from "vite-config-custom";

export default (env: ConfigEnv) => {
  const config = NodeConfig(env, {
    // CSS is an explicit public asset. Node/SSR can import classes and contracts
    // without needing a CSS loader, and contracts never pull in preset CSS.
    plugins: [vanillaExtractPlugin() as unknown as never],
    build: {
      cssCodeSplit: false,
      lib: {
        entry: Object.fromEntries(
          ["index", "config", "presets"].map((name) => [
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
