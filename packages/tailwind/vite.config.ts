import { resolve } from "node:path";
import type { ConfigEnv } from "vite";
import { NodeConfig } from "vite-config-custom";

export default (env: ConfigEnv) =>
  NodeConfig(env, {
    build: {
      lib: {
        entry: resolve(import.meta.dirname, "src/index.ts")
      }
    }
  });
