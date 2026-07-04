import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { minchoVitePlugin } from "@mincho-js/vite";
import type { PluginOption } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Run Mincho before React so css-prop and styled transforms lower before JSX handling.
    minchoVitePlugin({ jsxCssProp: true }) as unknown as PluginOption,
    react(),
  ],
  esbuild: {
    jsxInject: `import React from "react"`,
  },
  build: {
    cssMinify: false,
    rollupOptions: {
      external: [],
      output: {
        manualChunks: undefined,
      },
    },
  },
  resolve: {
    preserveSymlinks: true,
  },
});
