import { resolve } from "node:path";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { minchoVitePlugin } from "@mincho-js/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [minchoVitePlugin(), vanillaExtractPlugin()],
  build: {
    cssCodeSplit: true,
    cssMinify: false,
    lib: {
      entry: {
        dynamic: resolve(import.meta.dirname, "src/dynamic.ts"),
        index: resolve(import.meta.dirname, "src/index.ts"),
        preset: resolve(import.meta.dirname, "src/preset.ts"),
        static: resolve(import.meta.dirname, "src/static.ts")
      },
      cssFileName: "style",
      fileName: (format, entryName) =>
        `${format === "es" ? "esm" : "cjs"}/${entryName}.${format === "es" ? "mjs" : "cjs"}`
    },
    minify: false,
    rollupOptions: {
      external: (id) =>
        id.startsWith("@mincho-js-proof/") && !id.endsWith("/style.css"),
      output: [{ format: "es" }, { format: "cjs", interop: "compat" }]
    },
    target: "es2020"
  }
});
