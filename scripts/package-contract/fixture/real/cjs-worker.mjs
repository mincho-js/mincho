import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { build as viteBuild } from "vite";

const require = createRequire(import.meta.url);
const workerThreads = require("node:worker_threads");
const NativeWorker = workerThreads.Worker;
const graphWorkers = [];
const graphResults = [];

// Observe native threads without changing their execution or loader arguments.
// This makes an accidental inline fallback fail the packaged CommonJS check.
workerThreads.Worker = class extends NativeWorker {
  constructor(filename, options) {
    super(filename, options);

    if (!String(filename).endsWith("/cjs/packageGraphWorker.cjs")) return;

    graphWorkers.push(this);
    this.on("message", (response) => {
      if (response.type === "result") graphResults.push(response.result);
    });
  }
};

try {
  const { minchoVitePlugin } = require("@mincho-js/vite");
  const built = await viteBuild({
    root: import.meta.dirname,
    configFile: false,
    logLevel: "silent",
    plugins: [minchoVitePlugin(), vanillaExtractPlugin()],
    build: {
      manifest: true,
      outDir: "dist-vite-cjs-plugin",
      lib: {
        entry: join(import.meta.dirname, "src/worker.ts"),
        formats: ["es"]
      },
      cssCodeSplit: true,
      minify: false,
      cssMinify: false
    }
  });

  assert.ok(
    graphWorkers.length > 0,
    "The CommonJS plugin must start its packaged CommonJS graph worker"
  );

  const expectedStyles = ["a", "b", "c", "d"].map(
    (name) => `@mincho-js-proof/real-${name}/style.css`
  );

  assert.ok(
    graphResults.some(
      (result) =>
        JSON.stringify(result.styleSpecifiers) ===
        JSON.stringify(expectedStyles)
    ),
    "The default worker must analyze the actual consumer's preset ancestors"
  );

  const outputs = (Array.isArray(built) ? built : [built]).flatMap(
    (result) => result.output
  );

  const manifestAsset = outputs.find(
    (output) =>
      output.type === "asset" && output.fileName === ".vite/manifest.json"
  );

  assert.ok(manifestAsset, "The CommonJS plugin build must emit a manifest");

  const manifest = JSON.parse(String(manifestAsset.source));
  const entry = Object.values(manifest).find((output) => output.isEntry);

  assert.equal(entry?.css?.length, 1);

  const entryCss = outputs.find(
    (output) => output.type === "asset" && output.fileName === entry.css[0]
  );

  assert.ok(entryCss, "The CommonJS plugin entry must retain its native CSS");

  const css = String(entryCss.source);

  assert.match(css, /margin:\s*2px\b/);
  assert.match(css, /display:\s*grid\b/);
  assert.equal(css.match(/padding:\s*4px\b/g)?.length, 1);
  assert.equal(css.match(/color:\s*red\b/g)?.length, 2);
  assert.ok(
    css.search(/padding:\s*4px\b/) < css.search(/color:\s*red\b/) &&
      css.search(/color:\s*red\b/) < css.search(/display:\s*grid\b/),
    "The CommonJS worker build must retain ancestor CSS dependency order"
  );

  console.log(
    "[package-contract] CommonJS Vite default worker: actual preset graph and CSS passed"
  );
} finally {
  workerThreads.Worker = NativeWorker;
  await Promise.all(graphWorkers.map((worker) => worker.terminate()));
}
