import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";

const require = createRequire(import.meta.url);

if (process.versions.pnp) {
  assert.throws(
    () => require.resolve("@babel/parser"),
    /isn't declared|not declared/
  );
}

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
  assert.equal(typeof esbuild.buildWithMincho, "function", mode);
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

const esmIntegration = await import("@mincho-js/integration");
const cjsIntegration = require("@mincho-js/integration");
const esmRegistry = await import("@mincho-js/css/defineRules/registry");
const cjsRegistry = require("@mincho-js/css/defineRules/registry");
const realPackageNames = ["a", "b", "c", "d"].map(
  (letter) => `@mincho-js-proof/real-${letter}`
);

const realPresets = await Promise.all(
  realPackageNames.map(async (name) => (await import(`${name}/preset`)).preset)
);

const localColor = (preset) =>
  preset.nodes
    .find((node) => node.nodeId === preset.rootNodeId)
    .atoms.find((atom) => atom.property === "color");

const bColor = localColor(realPresets[1]);
const cColor = localColor(realPresets[2]);

assert.equal(bColor.atomId, cColor.atomId);
assert.notEqual(bColor.className, cColor.className);

for (const registry of [esmRegistry, cjsRegistry]) {
  const validated = realPresets.map((preset) =>
    registry.parseDefineRulesPresetArtifactV5(preset)
  );

  const graph = registry.resolveDefineRulesPresetGraphV5([validated[3]]);

  assert.deepEqual(graph.styleOrigins, realPackageNames);
  assert.ok(graph.atomIdByClassName.has(bColor.className));
  assert.ok(graph.atomIdByClassName.has(cColor.className));
  assert.equal(graph.atomById.get(bColor.atomId).className, cColor.className);
}

const registryFile = join(import.meta.dirname, "mixed-registry.css.ts");
const registrySources = await Promise.all(
  [esmIntegration, cjsIntegration].map((integration, index) =>
    integration.compile({
      filePath: registryFile,
      originalPath: registryFile,
      contents: `
      import { defineRules } from "@mincho-js/css";
      const rules = defineRules({ properties: { color: true } });
      export const className = rules.css({ color: ${JSON.stringify(index === 0 ? "red" : "blue")} });
      export const preset = rules.preset;
    `,
      resolverCache: new Map()
    })
  )
);

let release;
const gate = new Promise((resolve) => {
  release = resolve;
});

let active = 0;
let maximumActive = 0;
const emittedCss = [[], []];
const evaluations = [esmIntegration, cjsIntegration].map((integration, index) =>
  integration.runDefineRulesPresetRegistryStep(async () => {
    maximumActive = Math.max(maximumActive, ++active);

    try {
      if (index === 0) await gate;

      return await integration.processDefineRulesPresetRegistryFile({
        filePath: registryFile,
        source: registrySources[index].source,
        identOption: "debug",

        serializeVirtualCssPath: ({ source, fileName }) => {
          emittedCss[index].push(source);

          return `import ${JSON.stringify(fileName)};`;
        }
      });
    } finally {
      active--;
    }
  })
);

await setImmediate();

assert.equal(active, 1, "mixed ESM/CJS queues must share the running step");

release();

const registryResults = await Promise.all(evaluations);

assert.equal(maximumActive, 1, "mixed ESM/CJS evaluation must serialize");

const artifacts = registryResults.map((result, index) => {
  assert.equal(result.registrySession.instances.length, 1);
  assert.ok(
    result.packageGraph,
    "serialized producers must return their graph"
  );

  const artifact = result.registrySession.instances[0].getPresetSnapshot();

  assert.equal(artifact.version, 5);
  assert.equal(Object.hasOwn(artifact, "classNameByCache"), false);
  assert.ok(
    result.source.includes(artifact.rootNodeId),
    "serialized JS must retain the V5 artifact"
  );
  assert.match(
    emittedCss[index].join("\n"),
    index === 0 ? /color: red/ : /color: blue/
  );

  return artifact;
});

for (const registry of [esmRegistry, cjsRegistry]) {
  assert.equal(registry.getActiveDefineRulesRegistrySession(), undefined);
  assert.deepEqual(
    registry.parseDefineRulesPresetArtifactV5(artifacts[0]),
    artifacts[0]
  );
  assert.throws(
    () =>
      registry.parseDefineRulesPresetArtifactV5({
        schema: "mincho.defineRulesPreset",
        version: 4,
        classNameByCache: {}
      }),
    /expected defineRules preset version 5/
  );

  const tampered = structuredClone(artifacts[0]);
  tampered.nodes[0].contentHash = "0".repeat(64);

  assert.throws(
    () => registry.parseDefineRulesPresetArtifactV5(tampered),
    /claimed node hashes/
  );
  assert.throws(
    () => registry.resolveDefineRulesPresetGraphV5(artifacts),
    /origin revision conflicts/
  );
}

await assert.rejects(
  esmIntegration.runDefineRulesPresetRegistryStep(() =>
    cjsIntegration.runDefineRulesPresetRegistryStep(() => "unreachable")
  ),
  /active registry step/
);
assert.equal(
  await cjsIntegration.runDefineRulesPresetRegistryStep(() => "recovered"),
  "recovered"
);
