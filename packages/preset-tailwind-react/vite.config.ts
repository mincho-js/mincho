import { resolve } from "node:path";
import type { ConfigEnv } from "vite";
import { NodeConfig } from "vite-config-custom";

export default (env: ConfigEnv) =>
  NodeConfig(env, {
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
