import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const root = await mkdtemp(join(import.meta.dirname, "evaluation-proof-"));
const filePath = join(root, "entry.css.ts");
const contents =
  'import { style } from "@vanilla-extract/css"; export const box = style({color: "red"});';

try {
  await writeFile(filePath, contents);

  for (const mode of ["import", "require"]) {
    const load = (id) => (mode === "import" ? import(id) : require(id));
    const integration = await load("@mincho-js/integration");
    const registry = await load("@mincho-js/css/defineRules/registry");
    const { source } = await integration.compile({
      filePath,
      originalPath: filePath,
      contents,
      resolverCache: new Map()
    });
    let expected;

    for (const evaluation of [undefined, "fresh", "auto"]) {
      for (const evaluationResults of [false, true]) {
        const execution = new integration.InternalCompilationExecution({
          workers: 0,
          evaluation
        });
        const cache = new integration.InternalCompilationCache();
        cache.configure(
          { type: "memory", evaluationResults },
          root,
          "contract"
        );
        execution.compilationCache = cache;
        const diagnostics = new integration.CompilationDiagnostics({
          console: true
        });
        let previous;

        try {
          for (let index = 0; index < 2; index++) {
            const css = [];
            const result = await diagnostics.run(filePath, "evaluation", () =>
              execution.run(() =>
                integration.runDefineRulesPresetRegistryStep(() =>
                  integration.processDefineRulesPresetRegistryFile({
                    source,
                    filePath,
                    serializeVirtualCssPath: ({ source: text }) => {
                      registry.getActiveDefineRulesRegistrySession()
                        .nextRegistrationIndex++;
                      css.push(text);

                      return "";
                    }
                  })
                )
              )
            );
            const value = {
              source: result.source,
              css,
              graph: result.packageGraph
            };
            expected ??= value;
            assert.deepEqual(
              value,
              expected,
              `${mode}/${evaluation}/${evaluationResults}: output`
            );
            assert.ok(css.join("\n").includes("red"));
            assert.equal(result.registrySession.nextRegistrationIndex, 1);
            assert.equal(
              registry.getActiveDefineRulesRegistrySession(),
              undefined
            );
            if (previous) {
              assert.notEqual(result.registrySession, previous.registrySession);
              assert.notEqual(
                result.registrySession.instances,
                previous.registrySession.instances
              );
            }
            previous = result;
          }

          const events = diagnostics
            .snapshot()
            .builds.flatMap((build) => build.events);
          const count = (phase) =>
            events.filter((event) => event.phase === phase).length;
          assert.equal(
            count("vm-evaluate"),
            evaluation === "auto" ? (evaluationResults ? 1 : 2) : 0
          );
          assert.equal(
            count("vm-context-reuse"),
            evaluation === "auto" && !evaluationResults ? 1 : 0
          );
          assert.equal(
            count("evaluation-result-hit"),
            evaluation === "auto" && evaluationResults ? 1 : 0
          );
        } finally {
          await execution.close();
          cache.clear();
        }
      }
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("[package-contract] installed ESM/CJS guarded evaluation passed");
