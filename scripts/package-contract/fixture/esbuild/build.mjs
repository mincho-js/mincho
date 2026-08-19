import { build } from "esbuild";
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";

await build({
  absWorkingDir: import.meta.dirname,
  bundle: true,
  entryPoints: ["src/index.ts", "src/cjs.cjs"],
  format: "esm",
  minify: false,
  outdir: "dist",
  platform: "browser",
  plugins: minchoEsbuildPlugins(),
  target: "es2020"
});
