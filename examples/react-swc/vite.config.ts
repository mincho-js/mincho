import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { minchoVitePlugin } from "@mincho-js/vite";
import type { PluginOption } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    cssMinify: false,
  },
  plugins: [
    minchoVitePlugin({ jsxCssProp: true }) as unknown as PluginOption,
    react({ jsxImportSource: "@mincho-js/react" }),
  ],
});
