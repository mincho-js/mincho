import type { ConfigEnv } from "vite";
import { NodeConfig } from "vite-config-custom";
import { resolve } from "node:path";

// == Vite Config =============================================================
// https://vitejs.dev/config/#build-lib
export default (viteConfigEnv: ConfigEnv) => {
  const config = NodeConfig(viteConfigEnv, {
    build: {
      lib: {
        entry: {
          stylesheets: resolve(process.cwd(), "src/stylesheets.ts"),
          "layout/index": resolve(process.cwd(), "src/layout/index.ts"),
          "squircle/index": resolve(process.cwd(), "src/squircle/index.ts"),
          index: resolve(process.cwd(), "src/index.ts"),
          config: resolve(process.cwd(), "src/config.ts"),
          runtime: resolve(process.cwd(), "src/runtime.ts"),
          "jsx-runtime": resolve(process.cwd(), "src/jsx-runtime.ts"),
          "jsx-dev-runtime": resolve(process.cwd(), "src/jsx-dev-runtime.ts"),
          "compiled-jsx-runtime": resolve(
            process.cwd(),
            "src/compiled-jsx-runtime.ts"
          ),
          "compiled-jsx-dev-runtime": resolve(
            process.cwd(),
            "src/compiled-jsx-dev-runtime.ts"
          )
        }
      }
    }
  });
  // Replace, rather than concatenate, NodeConfig's output array.
  config.build!.rollupOptions!.output = ["es", "cjs"].map((format) => ({
    format: format as "es" | "cjs",
    ...(format === "cjs" ? { interop: "compat" as const } : {}),
    banner: (chunk: { name: string }) =>
      ["layout/index", "squircle/index"].includes(chunk.name)
        ? '"use client";'
        : ""
  }));
  return config;
};
