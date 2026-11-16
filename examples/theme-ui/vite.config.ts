import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { minchoVitePlugin } from "@mincho-js/vite";
import { extractCalls } from "@mincho-js/preset-theme-ui-react/config";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";

export default defineConfig({
  plugins: [
    minchoVitePlugin({
      jsxCssProp: { importSource: "@mincho-js/preset-theme-ui-react" },
      extractCalls
    }),
    vanillaExtractPlugin(),
    react({ jsxImportSource: "@mincho-js/preset-theme-ui-react" })
  ]
});
