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
      function helpers(depth) {
        return 'const f0 = () => ({color: "red"});' +
          Array.from({ length: depth }, (_, i) =>
            'const f' + (i + 1) + ' = () => false ? f' + i + '() : f' + i + '();'
          ).join('') + 'export const style = f' + depth + '();';
      }
      for (const depth of [10, 25]) {
        let mutated;
        const run = () => transformSync(helpers(depth) + '<div css={style}/>;', {
          filename: "/owner.tsx", configFile: false, babelrc: false,
          parserOpts: { plugins: ["jsx"] },
          plugins: [() => ({ visitor: { Program(program) {
            mutated = hasStaticCssEvalBindingMutation(program, program.scope.getBinding("style"));
            program.stop();
          }}})]
        });
        if (depth === 10) {
          assert.doesNotThrow(run);
          assert.equal(mutated, false);
        } else {
          assert.throws(run, /mutation analysis node visit limit exceeded/);
          assert.equal(mutated, undefined);
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
