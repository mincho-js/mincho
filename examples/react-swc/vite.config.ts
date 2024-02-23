import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc"
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { vanillaExtractPlugin as vanillaExtractBuildPlugin } from "@vanilla-extract/esbuild-plugin";

// https://vitejs.dev/config/
export default defineConfig({
  optimizeDeps: {
    esbuildOptions: {
      plugins: [vanillaExtractBuildPlugin({ runtime: true })]
    }
  },
  plugins: [react(), vanillaExtractPlugin()],
});
