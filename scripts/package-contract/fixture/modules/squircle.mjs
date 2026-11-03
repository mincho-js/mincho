import assert from "node:assert/strict";
import { join } from "node:path";
import { build as vite } from "vite";
import { build as esbuild } from "esbuild";
import { minchoVitePlugin } from "@mincho-js/vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";

const result = await vite({
  root: import.meta.dirname,
  configFile: false,
  logLevel: "silent",
  plugins: [minchoVitePlugin(), vanillaExtractPlugin()],
  build: {
    write: false,
    minify: false,
    cssMinify: false,
    cssCodeSplit: true,
    lib: {
      entry: join(import.meta.dirname, "squircle.css.ts"),
      formats: ["es", "cjs"]
    }
  }
});
for (const bundle of Array.isArray(result) ? result : [result]) {
  const css = bundle.output
    .filter((file) => file.type === "asset" && file.fileName.endsWith(".css"))
    .map((file) => String(file.source))
    .join("\n");
  const js = bundle.output
    .filter((file) => file.type === "chunk")
    .map((file) => file.code)
    .join("\n");
  assert.match(css, /mask-image:\s*url\(/);
  assert.match(css, /data:image\/svg\+xml/);
  assert.match(css, /width:\s*80px/);
  assert.doesNotMatch(js, /data:image|ResizeObserver|getSquircleMask/);
}

const core = await esbuild({
  stdin: {
    contents: 'export { getSquirclePath } from "@mincho-js/css/squircle/core";',
    resolveDir: import.meta.dirname
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  metafile: true
});
assert.ok(
  Object.keys(core.metafile.inputs).every(
    (path) => !/node_modules\/(?:@vanilla-extract|react|react-dom)\//.test(path)
  ),
  "pure geometry must not pull React or CSS authoring into a browser bundle"
);
