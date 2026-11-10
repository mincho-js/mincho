import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { minchoVitePlugin } from "@mincho-js/vite";
import { extractCalls } from "@mincho-js/preset-theme-ui/config";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";

export default defineConfig({
  // Extract preset calls and mincho$() blocks before React transforms JSX.
  plugins: [minchoVitePlugin({ extractCalls }), vanillaExtractPlugin(), react()]
});
