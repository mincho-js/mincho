import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build as vite } from "vite";
import { build as esbuild } from "esbuild";
import { minchoVitePlugin } from "@mincho-js/vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { selectors as rootSelectors } from "@mincho-js/css";
import { selectors } from "@mincho-js/css/selectors";

const require = createRequire(import.meta.url);
const cjs = require("@mincho-js/css/selectors").selectors;
assert.equal(require("@mincho-js/css").selectors, cjs);
assert.equal(rootSelectors, selectors);
assert.equal(Object.keys(selectors).length, 33);
assert.deepEqual(Object.keys(cjs).sort(), Object.keys(selectors).sort());
assert.equal(
  cjs.children(".list", ".item", cjs.first()),
  selectors.children(".list", ".item", selectors.first())
);
assert.equal(
  cjs.children(".list", ".item", selectors.first()),
  selectors.children(".list", ".item", cjs.first())
);

const extracted = await vite({
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
      entry: join(import.meta.dirname, "selectors.css.ts"),
      formats: ["es", "cjs"]
    }
  }
});
for (const bundle of Array.isArray(extracted) ? extracted : [extracted]) {
  const css = bundle.output
    .filter((file) => file.type === "asset")
    .map((file) => String(file.source))
    .join("\n");
  const js = bundle.output
    .filter((file) => file.type === "chunk")
    .map((file) => file.code)
    .join("\n");
  assert.match(css, /:nth-last-child\(n\+5 of \.item\)/);
  assert.match(css, /:nth-child\(n\+2 of \.item\)/);
  assert.match(css, /color:\s*tomato/);
  assert.match(css, /:is\(:hover, :focus\)/);
  assert.doesNotMatch(
    js,
    /mincho\.selector\.condition|postcss-selector-parser|nth-child/
  );
}

const entry = join(import.meta.dirname, "selectors-probe.js");
const contents =
  'import { selectors } from "@mincho-js/css/selectors"; export const condition = selectors.first();';
const shaken = await vite({
  root: import.meta.dirname,
  configFile: false,
  logLevel: "silent",
  plugins: [
    {
      name: "selectors-probe",
      resolveId(id) {
        if (id === entry) return id;
      },
      load(id) {
        if (id === entry) return contents;
      }
    }
  ],
  build: { write: false, minify: false, lib: { entry, formats: ["es"] } }
});
const code = (Array.isArray(shaken) ? shaken : [shaken])
  .flatMap((bundle) => bundle.output)
  .filter((file) => file.type === "chunk")
  .map((file) => file.code)
  .join("\n");
assert.match(code, /mincho\.selector\.condition/);
assert.doesNotMatch(
  code,
  /postcss|countAtLeast|nth-last-child|walkNesting|Expected a complete element selector/
);
assert.ok(
  code.length < 2000,
  "one position helper must not retain the full namespace or selector parser in Vite/Rollup"
);

// Native esbuild currently retains exported namespaces. Check interoperability
// without claiming per-function tree shaking for that consumer.
const native = await esbuild({
  stdin: { contents, resolveDir: import.meta.dirname },
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm"
});
assert.ok(native.outputFiles[0].contents.length > 0);
