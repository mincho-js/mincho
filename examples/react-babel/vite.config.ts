import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { minchoVitePlugin } from "@mincho-js/vite";
import type { PluginOption } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Only use the minchoVitePlugin which handles all necessary transformations
    minchoVitePlugin() as unknown as PluginOption,
    // Add React plugin without custom Babel config
    react(),
  ],
});
