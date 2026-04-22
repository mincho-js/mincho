import { resolve } from "node:path";
import type { ConfigEnv } from "vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { minchoVitePlugin } from "@mincho-js/vite";
import { NodeConfig } from "vite-config-custom";

// == Vite Config =============================================================
// https://vite.dev/config/
export default (viteConfigEnv: ConfigEnv) => {
  return NodeConfig(viteConfigEnv, {
    build: {
      lib: {
        entry: {
          index: resolve(import.meta.dirname, "src/index.ts")
        },
        cssFileName: "style"
      }
    },
    plugins: [
      minchoVitePlugin() as unknown as never,
      vanillaExtractPlugin() as unknown as never
    ],
    resolve: {
      preserveSymlinks: true
    }
  });
};
