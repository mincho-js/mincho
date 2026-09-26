import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const root = await mkdtemp(join(import.meta.dirname, "cache-proof-"));
const filename = join(root, "entry.ts");
await writeFile(
  filename,
  'import { css } from "@mincho-js/css"; export const box = css({ color: "red" });'
);

const script = `
  import { createRequire } from "node:module";
  import { readFile } from "node:fs/promises";
  const [filename, directory, mode, options] = process.argv.slice(1);
  const { InternalCompilationCache, CompilationDiagnostics, babelTransformSource } =
    mode === "import" ? await import("@mincho-js/integration") : createRequire(import.meta.url)("@mincho-js/integration");
  const cache = new InternalCompilationCache();
  cache.configure(JSON.parse(options).cache, directory, mode);
  const diagnostics = new CompilationDiagnostics({ console: true });
  const source = await readFile(filename, "utf8");
  const result = await diagnostics.run(filename, "transform", () => babelTransformSource({
    filename, source, babel: { compilationCache: cache }
  }));
  const hit = diagnostics.snapshot().builds.some(build => build.events.some(event => event.phase === "cache-hit"));
  process.stdout.write(JSON.stringify({ result, hit }));
`;

try {
  for (const mode of ["import", "require"])
    for (const [name, cache, persistent] of [
      ["omitted", undefined, true],
      ["enabled", true, true],
      ["filesystem", { type: "filesystem" }, true],
      ["memory", { type: "memory" }, false],
      ["disabled", false, false]
    ]) {
      const run = async () => {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            script,
            filename,
            join(root, mode, name),
            mode,
            JSON.stringify({ cache })
          ],
          { cwd: root, timeout: 30_000 }
        );

        return JSON.parse(stdout);
      };

      const cold = await run();
      const warm = await run();
      assert.equal(cold.hit, false, `${mode}: cold compilation`);
      assert.equal(
        warm.hit,
        persistent,
        `${mode}/${name}: cache behavior in a new process`
      );
      assert.deepEqual(warm.result, cold.result, `${mode}: transformed output`);
    }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(
  "[package-contract] installed ESM/CJS filesystem cache reuse passed"
);
