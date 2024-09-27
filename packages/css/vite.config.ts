import { join } from "node:path";
import type { ConfigEnv } from "vite";
import { NodeConfig } from "vite-config-custom";

// == Vite Config =============================================================
// https://vitejs.dev/config/#build-lib
export default (viteConfigEnv: ConfigEnv) => {
  const packageDir = process.cwd();
  return NodeConfig(viteConfigEnv, {
    build: {
      lib: {
        entry: {
          // index: join(packageDir, "src", "index.ts"),
          "rules/createRuntimeFn": join(
            packageDir,
            "src",
            "rules",
            "createRuntimeFn.ts"
          )
        }
      },
      rollupOptions: {
        output: {
          manualChunks: undefined
        }
      }
    }
  });
};
