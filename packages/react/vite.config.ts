import type { ConfigEnv } from "vite";
import { NodeConfig } from "vite-config-custom";
import { resolve } from "node:path";

// == Vite Config =============================================================
// https://vitejs.dev/config/#build-lib
export default (viteConfigEnv: ConfigEnv) => {
  return NodeConfig(viteConfigEnv, {
    build: {
      lib: {
        entry: {
          index: resolve(process.cwd(), "src/index.ts"),
          runtime: resolve(process.cwd(), "src/runtime.ts"),
          "jsx-runtime": resolve(process.cwd(), "src/jsx-runtime.ts"),
          "jsx-dev-runtime": resolve(process.cwd(), "src/jsx-dev-runtime.ts")
        }
      }
    }
  });
};
