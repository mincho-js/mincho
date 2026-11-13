/// <reference types="node" />

import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("mutation analysis traversal budget", () => {
  it("bounds repeated helper returns before classifying a binding as safe", async () => {
    // This source test also participates in CommonJS declaration builds.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore error TS1343
    const mutationUrl = new URL("./mutation.ts", import.meta.url);
    const mutationPath = fileURLToPath(mutationUrl);
    const script = `
      import assert from "node:assert/strict";
      import { transformSync } from "@babel/core";
      import { hasStaticCssEvalBindingMutation } from ${JSON.stringify(mutationPath)};
      import { analyzeAliasedStaticCssEvalBindingMutation } from ${JSON.stringify(fileURLToPath(new URL("./mutationAliases.ts", mutationUrl)))};
      function helpers(depth, condition = "condition") {
        return 'const f0 = () => ({color: "red"});' +
          Array.from({ length: depth }, (_, i) =>
            'const f' + (i + 1) + ' = () => ' + condition + ' ? f' + i + '() : f' + i + '();'
          ).join('') + 'export const style = f' + depth + '();';
      }
      // An unknown branch still expands both paths; literal false now has
      // a bounded selection proof and should not consume an exponential budget.
      for (const [depth, condition] of [[10, "condition"], [25, "condition"], [25, "false"]]) {
        let mutated;
        let proof;
        const run = () => transformSync(helpers(depth, condition) + '<div css={style}/>;', {
          filename: "/owner.tsx", configFile: false, babelrc: false,
          parserOpts: { plugins: ["jsx"] },
          plugins: [() => ({ visitor: { Program(program) {
            const binding = program.scope.getBinding("style");
            proof = analyzeAliasedStaticCssEvalBindingMutation(program, binding);
            mutated = hasStaticCssEvalBindingMutation(program, binding);
            program.stop();
          }}})]
        });
        if (depth === 10 || condition === "false") {
          assert.doesNotThrow(run);
          assert.equal(mutated, false);
          assert.equal(proof.kind, "proved-unmodified");
        } else {
          assert.doesNotThrow(run);
          assert.equal(mutated, true);
          assert.equal(proof.kind, "unknown");
          assert.equal(proof.reason, "analysis-limit");
        }
      }
      process.stdout.write("mutation analysis bounded");
    `;

    const compiled = await build({
      stdin: {
        contents: script,
        resolveDir: dirname(mutationPath),
        sourcefile: "mutation-budget.mjs"
      },
      bundle: true,
      packages: "external",
      platform: "node",
      target: "node20",
      format: "esm",
      write: false
    });

    const execution = execute(
      process.execPath,
      ["--max-old-space-size=256", "--input-type=module", "-"],
      { cwd: dirname(mutationPath), timeout: 10_000, maxBuffer: 64 * 1024 }
    );
    execution.child.stdin!.end(compiled.outputFiles[0]!.text);
    const result = await execution;

    expect(result.stdout).toBe("mutation analysis bounded");
  }, 15_000);
});
