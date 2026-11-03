import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: [
      {
        find: "@mincho-js/react/squircle",
        replacement: fileURLToPath(
          new URL("../../packages/react/src/squircle/index.ts", import.meta.url)
        )
      },
      {
        find: "@mincho-js/css/squircle/core",
        replacement: fileURLToPath(
          new URL("../../packages/css/src/squircle/core.ts", import.meta.url)
        )
      },
      {
        find: "@mincho-js/react/layout",
        replacement: fileURLToPath(
          new URL("../../packages/react/src/layout/index.ts", import.meta.url)
        )
      },
      {
        find: "@mincho-js/css/layout/core",
        replacement: fileURLToPath(
          new URL("../../packages/css/src/layout/core.ts", import.meta.url)
        )
      }
    ]
  },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 5173, strictPort: true }
});
