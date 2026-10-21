import { join } from "node:path";
import type { ConfigEnv } from "vite";
import { NodeConfig } from "vite-config-custom";

// == Vite Config =============================================================
// https://vitejs.dev/config/#build-lib
export default (viteConfigEnv: ConfigEnv) => {
  return NodeConfig(viteConfigEnv, {
    build: {
      lib: {
        entry: {
          "css-loading": join(process.cwd(), "src/css-loading.ts"),
          ssr: join(process.cwd(), "src/ssr.ts"),
          index: join(process.cwd(), "src", "index.ts"),
          packageGraphWorker: join(
            process.cwd(),
            "src",
            "packageGraphWorker.ts"
          )
        }
      }
    },
    test: {
      // Native build regressions each run Vite; avoid competing compiler pools.
      fileParallelism: false,
      testTimeout: 20_000
    }
  });
};
