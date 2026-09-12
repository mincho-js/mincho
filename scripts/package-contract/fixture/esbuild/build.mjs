import { build } from "esbuild";
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";

const minify = process.argv.includes("--minify");

await build({
  absWorkingDir: import.meta.dirname,
  bundle: true,
  entryPoints: ["src/index.ts", "src/cjs.cjs"],
  format: "esm",
  minify,
  outdir: minify ? "dist-minified" : "dist",
  platform: "browser",
  plugins: minchoEsbuildPlugins(),
  target: "es2020"
});
