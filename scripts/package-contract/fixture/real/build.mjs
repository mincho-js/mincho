import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildWithMincho } from "@mincho-js/esbuild";
import { minchoVitePlugin } from "@mincho-js/vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { build as viteBuild } from "vite";

for (const minify of [false, true]) {
  const suffix = minify ? "-minified" : "";
  const result = await buildWithMincho({
    absWorkingDir: import.meta.dirname,
    entryPoints: ["src/index.ts"],
    outdir: `dist-esbuild${suffix}`,
    bundle: true,
    format: "esm",
    splitting: true,
    sourcemap: true,
    metafile: true,
    minify
  });

  await writeFile(
    join(import.meta.dirname, `esbuild${suffix}-metafile.json`),
    JSON.stringify(result.metafile)
  );

  // This checks production CSS and tree shaking. U1's expected failures cover
  // Vite library source maps/hashes and automatic lazy CSS wiring separately.
  await viteBuild({
    root: import.meta.dirname,
    configFile: false,
    logLevel: "silent",
    plugins: [minchoVitePlugin(), vanillaExtractPlugin()],
    build: {
      manifest: true,
      outDir: `dist-vite${suffix}`,
      lib: {
        entry: join(import.meta.dirname, "src/index.ts"),
        formats: ["es"]
      },
      cssCodeSplit: true,
      minify: minify ? "esbuild" : false,
      cssMinify: minify ? "esbuild" : false
    }
  });
}
