// Run from the repository root after building @mincho-js/babel:
// yarn node --expose-gc scripts/benchmark-static-css-execution.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const workspace = resolve("packages/integration");
const require = createRequire(resolve(workspace, "package.json"));
const { build } = require("esbuild");
const { InternalSourceAstCache } = require("@mincho-js/babel");
await mkdir(resolve(workspace, ".cache"), { recursive: true });
const temporary = await mkdtemp(resolve(workspace, ".cache/execution-bench-"));

try {
  const entry = resolve(temporary, "prepass.mjs");
  await build({
    entryPoints: [resolve(workspace, "src/staticCssEvalPrepass.ts")],
    outfile: entry,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    define: { "import.meta.vitest": "undefined" }
  });
  const { createStaticCssEvalPrepass, STATIC_CSS_EVAL_EXECUTION_LIMITS } =
    await import(pathToFileURL(entry).href);

  async function measure(owners, graphModules) {
    global.gc?.();
    let cacheHits = 0;
    const cache = new InternalSourceAstCache((hit) => {
      if (hit) cacheHits++;
    });
    const samples = [];
    for (let index = 0; index < owners; index++) {
      let loads = 0;
      let resolutions = 0;
      const owner = `/owner-${index}.tsx`;
      const source = {
        resolve(_importer, specifier) {
          resolutions++;
          return {
            id: specifier,
            sourceKind: specifier.startsWith("/graph/")
              ? "package-source"
              : "project-source"
          };
        },
        load(id) {
          loads++;
          if (id === owner)
            return {
              sourceText:
                'import { tokens } from "/tokens.ts"; import "/graph/0.ts"; <div css={{color: tokens.color}} />;'
            };
          if (id === "/tokens.ts")
            return { sourceText: 'export const tokens = {color: "red"};' };
          const next = Number(id.slice("/graph/".length, -3)) + 1;
          return {
            sourceText:
              (next < graphModules ? `import "/graph/${next}.ts";` : "") +
              "export function helper() { return 1; }"
          };
        }
      };
      const start = performance.now();
      const result = await createStaticCssEvalPrepass(owner, source, cache);
      const milliseconds = performance.now() - start;
      const limited =
        graphModules + 2 > STATIC_CSS_EVAL_EXECUTION_LIMITS.modules;
      assert.equal(result.diagnostics.length, limited ? 1 : 0);
      if (limited) {
        assert.match(
          result.diagnostics[0].message,
          /execution.*modules per owner/
        );
        assert.equal(loads, STATIC_CSS_EVAL_EXECUTION_LIMITS.modules);
      } else {
        assert.equal(loads, graphModules + 2);
      }
      assert.deepEqual(
        result.result.ownerToDependencies.get(owner),
        result.result.dependencyFiles
      );
      assert.equal(
        result.provider.getResolvedCssValue({
          importerId: owner,
          bindingName: "tokens",
          memberPath: ["color"],
          expressionStart: 0,
          expressionEnd: 1
        }).kind,
        limited ? "not-candidate" : "resolved"
      );
      samples.push({ milliseconds, loads, resolutions, limited });
    }
    return { samples, cacheHits };
  }

  const cases = [];
  for (const graphModules of [240, 1001]) {
    for (const owners of [1, 8]) {
      // Warm the code path without warming the per-round parser cache.
      await measure(1, graphModules);
      const rounds = [];
      for (let round = 0; round < 3; round++)
        rounds.push(await measure(owners, graphModules));
      cases.push({ owners, graphModules, rounds });
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        limits: STATIC_CSS_EVAL_EXECUTION_LIMITS,
        note: "Prepass-only synthetic in-memory graph; shared default parser cache within each round. No filesystem, full compilation or cross-owner execution graph cache. The execution limit is separate from package-source policy limits.",
        cases
      },
      null,
      2
    )
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
