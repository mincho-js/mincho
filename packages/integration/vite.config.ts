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
          index: join(process.cwd(), "src", "index.ts"),
          "package-graph": join(process.cwd(), "src", "package-graph.ts")
        }
      }
    },
    test: {
      testTimeout: 20_000
    }
  });
};
