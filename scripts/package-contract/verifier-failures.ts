import {
  assertDiamondSelectorsOnce,
  assertV5PresetOutput,
  assertV5PresetOutputs
} from "./diamond-artifacts.js";
import {
  assertNoWorkspaceDependencySpecs,
  assertStyleExport
} from "./installed-package-contract.js";
import { assertDecoderFailurePaths } from "./decoder-failures.js";
import { PackageContractError } from "./types.js";

function assertContract(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new PackageContractError(detail);
}

function assertFailure(
  label: string,
  expectedDetail: string,
  action: () => void
): void {
  try {
    action();
  } catch (error) {
    if (error instanceof PackageContractError) {
      assertContract(
        error.detail.includes(expectedDetail),
        `${label} failed with an unexpected diagnostic: ${error.detail}`
      );
      return;
    }
    throw error;
  }
  throw new PackageContractError(
    `Expected failure path did not fail: ${label}`
  );
}

export function assertVerifierFailurePaths(): void {
  const v5PresetFixture = `({
    schema: "mincho.defineRulesPreset",
    version: 5,
    rootNodeId: "9e7d41b114350107dd7e123365a312bb66e0750f3addd67c2940fcb43e0fb66a",
    nodes: [{
      nodeId: "9e7d41b114350107dd7e123365a312bb66e0750f3addd67c2940fcb43e0fb66a",
      origin: "@mincho-js-proof/diamond-a:dist/index.js#defineRules:0",
      contentHash: "8e4b3a6ac52bc0dedf15d1c660d3c3790eae9094365607eb8fe980d2fcd37a63",
      parents: [],
      atoms: [{
        atomId: "71670b65e112f4969c5e51086423166050e55a7fbad2d4a62ed42c385a279963",
        cacheKey: "1fzq9ac",
        className: "diamond_a_display",
        condition: {
          layer: null,
          supports: null,
          media: null,
          container: null,
          selector: "&"
        },
        property: "display"
      }]
    }]
  })`;
  const exportedV5PresetFixture = `export const preset = ${v5PresetFixture};`;
  assertDecoderFailurePaths(v5PresetFixture);
  assertV5PresetOutputs(
    [
      {
        label: "esm/preset.mjs",
        source: `import { value as preset } from "./chunk.js"; export { preset };`
      },
      {
        label: "esm/chunk.js",
        source: `export const value = ${v5PresetFixture};`
      },
      {
        label: "cjs/preset.cjs",
        source: `exports.preset = ${v5PresetFixture};`
      }
    ],
    "relative ESM re-export fixture",
    ["esm/preset.mjs", "cjs/preset.cjs"],
    ["esm/preset.mjs", "cjs/preset.cjs"]
  );
  assertV5PresetOutputs(
    [
      {
        label: "esm/direct-preset.mjs",
        source: `export { value as preset } from "./direct-chunk.js";`
      },
      {
        label: "esm/direct-chunk.js",
        source: `export const value = ${v5PresetFixture};`
      },
      {
        label: "cjs/direct-preset.cjs",
        source: `exports.preset = ${v5PresetFixture};`
      }
    ],
    "direct relative ESM re-export fixture",
    ["esm/direct-preset.mjs", "cjs/direct-preset.cjs"],
    ["esm/direct-preset.mjs", "cjs/direct-preset.cjs"]
  );

  assertFailure(
    "workspace-path dependency",
    "retains a workspace-path dependency",
    () =>
      assertNoWorkspaceDependencySpecs({
        name: "@package-contract/bad-dependency",
        version: "0.0.0",
        private: false,
        dependencies: { "@mincho-js/css": "workspace:^" },
        optionalDependencies: {},
        exports: "./index.js",
        files: []
      })
  );
  assertFailure(
    "missing style export",
    "is missing the ./style.css export",
    () =>
      assertStyleExport({
        name: "@package-contract/missing-style",
        version: "0.0.0",
        private: false,
        dependencies: {},
        optionalDependencies: {},
        exports: { ".": "./index.js" },
        files: []
      })
  );
  assertFailure(
    "missing package diamond selector",
    "selector count changed",
    () => assertDiamondSelectorsOnce(".diamond_a_display {}", "failure fixture")
  );
  assertFailure("missing V5 graph field", "contains unsupported fields", () =>
    assertV5PresetOutput(
      exportedV5PresetFixture.replace(
        'property: "display"',
        'legacyProperty: "display"'
      ),
      "failure fixture"
    )
  );
  assertFailure(
    "incomplete exported sibling V5 artifact",
    "contains unsupported fields",
    () =>
      assertV5PresetOutput(
        `const nodes = [];
       const helper = { schema: "mincho.defineRulesPreset", version: 5, nodes };
       export const preset = {
         first: ${v5PresetFixture},
         second: ${v5PresetFixture.replace("nodes:", "legacyNodes:")}
       };`,
        "failure fixture"
      )
  );
  assertFailure("legacy V5 preset field", "contains unsupported fields", () =>
    assertV5PresetOutput(
      exportedV5PresetFixture.replace(
        "rootNodeId:",
        "writeKeyByCacheKey: {}, rootNodeId:"
      ),
      "failure fixture"
    )
  );
  assertFailure("malformed V5 hash", "expected a SHA-256 hash", () =>
    assertV5PresetOutput(
      exportedV5PresetFixture.replace(
        'rootNodeId: "9e7d41b114350107dd7e123365a312bb66e0750f3addd67c2940fcb43e0fb66a"',
        'rootNodeId: "root"'
      ),
      "failure fixture"
    )
  );
  assertFailure(
    "missing format-specific preset output",
    "missing required JS artifact cjs/preset.cjs",
    () =>
      assertV5PresetOutputs(
        [{ label: "esm/preset.mjs", source: exportedV5PresetFixture }],
        "failure fixture",
        ["esm/preset.mjs", "cjs/preset.cjs"],
        ["esm/preset.mjs", "cjs/preset.cjs"]
      )
  );
  assertFailure(
    "empty format-specific preset output",
    "cjs/preset.cjs schema is absent",
    () =>
      assertV5PresetOutputs(
        [
          { label: "esm/preset.mjs", source: exportedV5PresetFixture },
          { label: "cjs/preset.cjs", source: "exports.value = true;" }
        ],
        "failure fixture",
        ["esm/preset.mjs", "cjs/preset.cjs"],
        ["esm/preset.mjs", "cjs/preset.cjs"]
      )
  );
  assertFailure(
    "reassigned V5 preset export",
    "not statically resolvable",
    () =>
      assertV5PresetOutput(
        `let preset = ${v5PresetFixture};
       preset = ${v5PresetFixture.replace("nodes:", "legacyNodes:")};
       export { preset };`,
        "failure fixture"
      )
  );
  assertFailure(
    "prototype-sensitive static key",
    "unsupported static object key __proto__",
    () =>
      assertV5PresetOutput(
        `export const preset = { __proto__: ${v5PresetFixture} };`,
        "failure fixture"
      )
  );
}
