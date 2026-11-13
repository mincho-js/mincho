import { resolve } from "node:path";
import type { ConfigEnv } from "vite";
import { NodeConfig } from "vite-config-custom";

export default (env: ConfigEnv) => {
  const config = NodeConfig(env, {
    build: {
      lib: {
        entry: Object.fromEntries(
          ["index", "config", "jsx-runtime", "jsx-dev-runtime"].map((name) => [
            name,
            resolve(import.meta.dirname, `src/${name}.ts`)
          ])
        )
      }
    }
  });

  // Keep the component compiler behind an internal module so importing theme
  // classes or runtime helpers does not retain its authoring dependencies.
  const outputs = config.build?.rollupOptions?.output;

  if (Array.isArray(outputs)) {
    for (const output of outputs) {
      output.preserveModules = true;
      output.preserveModulesRoot = resolve(import.meta.dirname, "src");
    }
  }

  return config;
};
