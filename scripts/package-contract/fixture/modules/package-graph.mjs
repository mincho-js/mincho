import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const specifier = "@mincho-js/integration/package-graph";

for (const mode of ["import", "require"]) {
  const entry =
    mode === "import"
      ? fileURLToPath(import.meta.resolve(specifier))
      : require.resolve(specifier);

  const { metafile } = await build({
    entryPoints: [entry],
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
      /\/(?:package-graph|defineRulesPackageGraph)[^/]*\.(?:mjs|cjs)$/,
      `${mode}: graph entry pulled in ${input}`
    );
    assert.equal(
      metadata.imports.some((entry) => entry.external),
      false
    );
  }
}
