import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

for (const mode of ["import", "require"]) {
  const api =
    mode === "import"
      ? await import("@mincho-js/integration/package-graph")
      : require("@mincho-js/integration/package-graph");

  const graph = api.collectDefineRulesPackageGraph([
    {
      rootNodeId: "app",
      nodes: [
        { nodeId: "base", origin: "base:rules", parents: [] },
        { nodeId: "app", origin: "app:rules", parents: ["base"] }
      ]
    }
  ]);

  const entry =
    mode === "import"
      ? fileURLToPath(import.meta.resolve("@mincho-js/vite"))
      : require.resolve("@mincho-js/vite");

  const workerEntry = join(
    dirname(entry),
    `packageGraphWorker.${mode === "import" ? "mjs" : "cjs"}`
  );

  const { metafile } = await build({
    entryPoints: [workerEntry],
    bundle: true,
    platform: "node",
    write: false,
    metafile: true,
    treeShaking: false,
    logLevel: "silent"
  });

  for (const [input, metadata] of Object.entries(metafile.inputs)) {
    assert.match(
      input,
      /\/(?:package-graph|defineRulesPackageGraph|packageGraphWorker|packageGraphAnalysisCore)[^/]*\.(?:mjs|cjs|js)$/,
      `${mode}: worker pulled in ${input}`
    );

    for (const imported of metadata.imports) {
      if (imported.external) assert.match(imported.path, /^node:/);
    }
  }

  const worker = new Worker(workerEntry);

  try {
    const response = once(worker, "message", {
      signal: AbortSignal.timeout(20_000)
    });
    worker.postMessage({ type: "reset", generation: 1 });
    worker.postMessage({
      type: "register",
      generation: 1,
      moduleId: "virtual:entry?client",
      graph
    });
    worker.postMessage({
      type: "analyze",
      generation: 1,
      requestId: 1,
      moduleIds: ["ordinary.js", "virtual:entry?client"]
    });

    const [result] = await response;

    assert.equal(result.type, "result", mode);
    assert.equal(result.generation, 1, mode);
    assert.equal(result.requestId, 1, mode);
    assert.deepEqual(result.result.graph, graph, mode);
    assert.deepEqual(
      result.result.styleSpecifiers,
      api.getDefineRulesPackageStyleSpecifiers(graph),
      mode
    );
  } finally {
    await worker.terminate();
  }
}
