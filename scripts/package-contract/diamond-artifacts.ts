import { build } from "esbuild";
import { parseDefineRulesPresetArtifactV5 } from "../../packages/css/src/defineRules/presetArtifact.js";
import type { DefineRulesPresetArtifactV5 } from "../../packages/css/src/defineRules/types.js";
import { PackageContractError } from "./types.js";

function assertContract(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new PackageContractError(detail);
}

export const diamondSelectors = [
  { packageName: "@mincho-js-proof/diamond-a", selector: ".diamond_a_display" },
  { packageName: "@mincho-js-proof/diamond-b", selector: ".diamond_b_color" },
  { packageName: "@mincho-js-proof/diamond-c", selector: ".diamond_c_color" },
  { packageName: "@mincho-js-proof/diamond-d", selector: ".diamond_d_padding" }
] as const;

export const diamondPackageNames = new Set<string>(
  diamondSelectors.map(({ packageName }) => packageName)
);

const presetSchemaPattern = /["']?schema["']?\s*:\s*["']mincho\.defineRulesPreset["']/;
const v5PresetPattern = /\{[^{}]*["']?schema["']?\s*:\s*["']mincho\.defineRulesPreset["'][^{}]*["']?version["']?\s*:\s*5(?=\s*[,}])/;
const legacyPresetPattern = /\{[^{}]*["']?schema["']?\s*:\s*["']mincho\.defineRulesPreset["'][^{}]*["']?version["']?\s*:\s*[34](?=\s*[,}])/;

export function count(source: string, value: string): number {
  return source.split(value).length - 1;
}

export function assertDiamondSelectorsOnce(source: string, label: string): void {
  for (const { selector } of diamondSelectors) {
    assertContract(
      count(source, selector) === 1,
      `${label} selector count changed: ${selector}`
    );
  }
}

export function assertNoRuntimeGraph(source: string, label: string): void {
  assertContract(!presetSchemaPattern.test(source), `${label} leaked preset graph: ${presetSchemaPattern.source}`);
}

export function assertV5PresetOutput(source: string, label: string, diamondOnly = false): void {
  assertContract(presetSchemaPattern.test(source), `${label} schema is absent`);
  assertContract(v5PresetPattern.test(source), `${label} is not V5-only`);
  assertContract(!legacyPresetPattern.test(source), `${label} retains legacy version output`);
  if (diamondOnly) {
    for (const { packageName } of diamondSelectors) {
      assertContract(source.includes(`${packageName}:`), `${label} omits ${packageName}`);
    }
  }
}

export function assertV5PresetArtifact(value: unknown, label: string): DefineRulesPresetArtifactV5 {
  try {
    return parseDefineRulesPresetArtifactV5(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PackageContractError(`${label} is not a valid V5 preset: ${detail}`);
  }
}

export function assertDiamondPresetOrigins(artifact: DefineRulesPresetArtifactV5, label: string): void {
  const origins = new Set(artifact.nodes.map(({ origin }) => origin.slice(0, origin.indexOf(":"))));
  assertContract(origins.size === diamondPackageNames.size, `${label} package origins changed`);
  for (const packageName of diamondPackageNames) {
    assertContract(origins.has(packageName), `${label} omits ${packageName}`);
  }
}

export async function presetExport(entrypoint: string, label: string, consumerRoot: string): Promise<unknown> {
  const result = await build({
    absWorkingDir: consumerRoot,
    bundle: true,
    format: "esm",
    loader: { ".css": "empty" },
    platform: "node",
    stdin: {
      contents: `
        import { preset as candidatePreset } from ${JSON.stringify(entrypoint)};
        import { parseDefineRulesPresetArtifactV5 } from "@mincho-js/css/defineRules/registry";
        import { createDefineRulesCssRuntime } from "@mincho-js/css/defineRules/createDefineRulesCssRuntime";

        const parsedPreset = parseDefineRulesPresetArtifactV5(candidatePreset);
        export const runtime = createDefineRulesCssRuntime({ presets: parsedPreset, properties: {} });
        export { parsedPreset as preset };
      `,
      resolveDir: consumerRoot,
      sourcefile: `${label}.mjs`
    },
    write: false
  });
  const output = result.outputFiles[0];
  assertContract(
    result.outputFiles.length === 1 && output !== undefined,
    `${label} did not emit one importable preset module`
  );
  const module: Record<string, unknown> = await import(
    `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`
  );
  return module["preset"];
}
