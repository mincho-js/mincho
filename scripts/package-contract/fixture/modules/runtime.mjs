import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const names = [
  "@mincho-js/babel",
  "@mincho-js/integration",
  "@mincho-js/esbuild",
  "@mincho-js/vite"
];

const source = 'export const App = () => <div css={{ color: "red" }} />;';

for (const mode of ["import", "require"]) {
  const [babel, integration, esbuild, vite] = await Promise.all(
    names.map((name) => (mode === "import" ? import(name) : require(name)))
  );

  assert.equal(typeof babel.minchoBabelPlugin(), "object", mode);
  assert.ok(
    esbuild.minchoEsbuildPlugins({ jsxCssProp: true }).length > 0,
    mode
  );
  assert.equal(
    typeof vite.minchoVitePlugin({ jsxCssProp: true }).name,
    "string",
    mode
  );

  const result = await integration.babelTransformSource({
    filename: join(import.meta.dirname, "source.tsx"),
    source,
    loader: "tsx",
    sourceMaps: true,
    babel: { jsxCssProp: true, babelrc: false, configFile: false }
  });

  assert.equal(result.jsxCssPropTransformed, true, mode);
  assert.match(result.result[1], /color: "red"/, mode);
  assert.deepEqual(result.map.sourcesContent, [source], mode);
}
