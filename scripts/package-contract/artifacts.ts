import { join } from "node:path";
import {
  cssSources,
  installedPackageDirectory,
  jsSources,
  packageDiamondCssSources,
  source
} from "./artifact-sources.js";
import {
  assertDiamondSelectorsOnce,
  assertNoRuntimeGraph,
  assertV5PresetOutput,
  assertV5PresetOutputs,
  count
} from "./diamond-artifacts.js";
import { PackageContractError } from "./types.js";

const viteEntryNames = ["dynamic", "index", "preset", "static"] as const;
const viteRequiredJsArtifacts = viteEntryNames.flatMap((entryName) => [
  `esm/${entryName}.mjs`,
  `cjs/${entryName}.cjs`
]);
const viteRequiredPresetArtifacts = [
  "esm/preset.mjs",
  "cjs/preset.cjs"
] as const;

function assertContract(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new PackageContractError(detail);
}

export async function assertBuildArtifacts(options: {
  readonly consumerRoot: string;
}): Promise<void> {
  const viteRoot = join(options.consumerRoot, "fixture", "vite", "dist");
  const esbuildRoot = join(options.consumerRoot, "fixture", "esbuild", "dist");
  const [viteStatic, viteJsFiles, viteCss, esbuildJs, esbuildCjs, esbuildCss] =
    await Promise.all([
      source(join(viteRoot, "esm", "static.mjs")),
      jsSources(viteRoot),
      cssSources(viteRoot),
      source(join(esbuildRoot, "index.js")),
      source(join(esbuildRoot, "cjs.js")),
      cssSources(esbuildRoot)
    ]);
  const viteJs = viteJsFiles.map(({ source }) => source).join("\n");
  const sharedRoot = installedPackageDirectory(
    options.consumerRoot,
    "@examples/shared-component"
  );
  const [
    sharedRuntime,
    sharedPreset,
    sharedPresetCjs,
    sharedCss,
    diamondRuntime,
    diamondPreset,
    packageCss
  ] = await Promise.all([
    source(join(sharedRoot, "dist", "esm", "index.mjs")),
    source(join(sharedRoot, "dist", "esm", "preset.mjs")),
    source(join(sharedRoot, "dist", "cjs", "preset.cjs")),
    source(join(sharedRoot, "dist", "style.css")),
    source(
      join(
        installedPackageDirectory(
          options.consumerRoot,
          "@mincho-js-proof/diamond-d"
        ),
        "dist",
        "index.js"
      )
    ),
    source(
      join(
        installedPackageDirectory(
          options.consumerRoot,
          "@mincho-js-proof/diamond-d"
        ),
        "dist",
        "preset.js"
      )
    ),
    packageDiamondCssSources(options.consumerRoot)
  ]);

  assertDiamondSelectorsOnce(packageCss, "installed package diamond CSS");
  assertDiamondSelectorsOnce(viteCss, "Vite consumer CSS");
  assertDiamondSelectorsOnce(esbuildCss, "esbuild consumer CSS");
  for (const [label, css] of [
    ["Vite", viteCss],
    ["esbuild", esbuildCss]
  ]) {
    assertContract(
      count(css, ".extends_parent_base") === 1,
      `${label} lost or duplicated inherited rules CSS`
    );
    assertContract(
      count(css, "mediumseagreen") === 1,
      `${label} lost or duplicated extended rules CSS`
    );
    assertContract(
      css.includes("display: grid"),
      `${label} lost extended defineRules CSS`
    );
  }
  for (const [label, runtime] of [
    ["Vite", viteStatic],
    ["esbuild", esbuildJs]
  ]) {
    assertContract(
      runtime.includes("extends_parent_base"),
      `${label} lost the parent rule class`
    );
    assertContract(
      runtime.includes("--extends_width"),
      `${label} lost the inherited prop variable`
    );
  }
  for (const format of ["esm/static.mjs", "cjs/static.cjs"]) {
    const runtime = await source(join(viteRoot, format));
    const ancestorImport = runtime.indexOf(
      '"@mincho-js-proof/diamond-a/style.css"'
    );
    const childImport = runtime.indexOf('"../static.css"');
    assertContract(
      ancestorImport >= 0 && childImport > ancestorImport,
      `Vite ${format} must import parent CSS before child CSS`
    );
  }
  const parentVariant = esbuildCss.indexOf(".extends_parent_small");
  assertContract(
    parentVariant >= 0 && parentVariant < esbuildCss.indexOf("mediumseagreen"),
    "esbuild must emit parent variant CSS before child base CSS"
  );
  assertContract(
    count(sharedCss, "rebeccapurple") === 1,
    "ancestor selector count changed"
  );
  assertContract(
    count(viteCss, "tomato") === 1,
    "Vite local selector count changed"
  );
  assertV5PresetOutput(diamondPreset, "diamond-d preset", true);
  assertV5PresetOutput(sharedPreset, "shared-component ESM preset");
  assertV5PresetOutput(sharedPresetCjs, "shared-component CommonJS preset");
  assertV5PresetOutputs(
    viteJsFiles,
    "Vite preset",
    viteRequiredJsArtifacts,
    viteRequiredPresetArtifacts
  );
  assertNoRuntimeGraph(diamondRuntime, "diamond-d runtime");
  assertNoRuntimeGraph(sharedRuntime, "shared-component runtime");
  assertNoRuntimeGraph(viteStatic, "static cx output");
  assertNoRuntimeGraph(esbuildJs, "esbuild runtime");
  assertNoRuntimeGraph(esbuildCjs, "esbuild CommonJS runtime");
  assertContract(
    esbuildCjs.includes("SharedExampleCard"),
    "esbuild did not consume the shared-component CommonJS entry"
  );
  assertContract(
    /['"]?classWrites['"]?\s*:/.test(viteJs),
    "dynamic cx table is absent"
  );
  assertContract(
    /['"]?segments['"]?\s*:/.test(viteJs),
    "dynamic cx segments are absent"
  );
  assertContract(
    !/['"]?classWrites['"]?\s*:/.test(viteStatic),
    "static cx retained a dynamic table"
  );
  assertContract(
    !/['"]?segments['"]?\s*:/.test(viteStatic),
    "static cx retained dynamic segments"
  );
  assertContract(
    esbuildCss.includes("rebeccapurple"),
    "esbuild did not emit the explicit ./style.css export"
  );
}
