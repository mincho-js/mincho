import { posix } from "node:path";
import {
  parseDefineRulesPresetArtifactV5,
  resolveDefineRulesPresetGraphV5
} from "@mincho-js/css/defineRules/registry";
import {
  exportedStaticValues,
  isStaticRecord,
  type StaticExport,
  type StaticRecord,
  type StaticValue
} from "./exported-presets.js";
import { collectEsmImportedExports } from "./static-exports.js";
import { PackageContractError } from "./types.js";

type Output = { readonly label: string; readonly source: string };
type PresetArtifact = ReturnType<typeof parseDefineRulesPresetArtifactV5>;

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

const propertyBoundary = String.raw`(?:^|[,{])\s*`;
const presetSchemaProperty = String.raw`["']?schema["']?\s*:\s*["']mincho\.defineRulesPreset["']`;
const runtimeGraphPatterns = [
  new RegExp(`${propertyBoundary}${presetSchemaProperty}`),
  /["']?rootNodeId["']?\s*:/
] as const;

export function count(source: string, value: string): number {
  return source.split(value).length - 1;
}

export function assertDiamondSelectorsOnce(
  source: string,
  label: string
): void {
  for (const { selector } of diamondSelectors) {
    assertContract(
      count(source, selector) === 1,
      `${label} selector count changed: ${selector}`
    );
  }
}

export function assertNoRuntimeGraph(source: string, label: string): void {
  for (const pattern of runtimeGraphPatterns) {
    assertContract(
      !pattern.test(source),
      `${label} leaked preset graph: ${pattern.source}`
    );
  }
}

function collectPresetArtifacts(
  value: StaticValue,
  artifacts: StaticRecord[]
): void {
  if (Array.isArray(value)) {
    for (const child of value) collectPresetArtifacts(child, artifacts);
    return;
  }
  if (!isStaticRecord(value)) return;
  if (
    Object.prototype.hasOwnProperty.call(value, "schema") &&
    value.schema === "mincho.defineRulesPreset"
  ) {
    artifacts.push(value);
  }
  for (const child of Object.values(value)) {
    collectPresetArtifacts(child, artifacts);
  }
}

function parseArtifact(value: StaticRecord, label: string): PresetArtifact {
  try {
    return parseDefineRulesPresetArtifactV5(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PackageContractError(`${label}: ${detail}`);
  }
}

function resolveArtifacts(
  artifacts: readonly PresetArtifact[],
  label: string
): void {
  try {
    resolveDefineRulesPresetGraphV5(artifacts);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PackageContractError(`${label}: ${detail}`);
  }
}

function parsedArtifacts(
  exportedValues: readonly StaticExport[],
  label: string
): PresetArtifact[] {
  const artifacts: PresetArtifact[] = [];
  for (const exported of exportedValues) {
    const exportedArtifacts: StaticRecord[] = [];
    collectPresetArtifacts(exported.value, exportedArtifacts);
    for (const [index, artifact] of exportedArtifacts.entries()) {
      const suffix =
        exportedArtifacts.length > 1 ? ` artifact ${index + 1}` : "";
      artifacts.push(
        parseArtifact(artifact, `${label} export ${exported.name}${suffix}`)
      );
    }
  }
  return artifacts;
}

function outputExports(
  label: string,
  outputs: ReadonlyMap<string, Output>,
  resolving: ReadonlySet<string>
): readonly StaticExport[] {
  assertContract(
    !resolving.has(label),
    `${label} has a CommonJS re-export cycle`
  );
  const output = outputs.get(label);
  assertContract(output !== undefined, `Missing JS artifact ${label}`);
  const nextResolving = new Set(resolving).add(label);
  const resolveReexport = (
    moduleSpecifier: string,
    memberName: string,
    supportedTarget: RegExp
  ): StaticValue => {
    assertContract(
      supportedTarget.test(moduleSpecifier),
      `${label} re-exports preset from unsupported target ${moduleSpecifier}`
    );
    const target = posix.normalize(
      posix.join(posix.dirname(label), moduleSpecifier)
    );
    assertContract(
      !posix.isAbsolute(target) && target !== ".." && !target.startsWith("../"),
      `${label} re-exports preset outside the artifact root`
    );
    const targetExport = outputExports(target, outputs, nextResolving).find(
      ({ name }) => name === memberName
    );
    assertContract(
      targetExport !== undefined,
      `${label} re-exports missing preset ${memberName} from ${target}`
    );
    return targetExport.value;
  };
  const directExports = exportedStaticValues(output.source, label, (reexport) =>
    resolveReexport(reexport.moduleSpecifier, reexport.memberName, /\.cjs$/)
  );
  const esmReexports = collectEsmImportedExports(output.source, label)
    .filter(({ exportName }) => /preset/i.test(exportName))
    .map(
      (reexport): StaticExport => ({
        name: reexport.exportName,
        value: resolveReexport(
          reexport.moduleSpecifier,
          reexport.memberName,
          /\.(?:m?js)$/
        )
      })
    );
  return [...directExports, ...esmReexports];
}

export function assertV5PresetOutput(
  source: string,
  label: string,
  diamondOnly = false
): void {
  const artifacts = parsedArtifacts(exportedStaticValues(source, label), label);
  assertContract(artifacts.length > 0, `${label} schema is absent`);
  resolveArtifacts(artifacts, label);
  if (diamondOnly) {
    const serializedArtifacts = JSON.stringify(artifacts);
    for (const { packageName } of diamondSelectors) {
      assertContract(
        serializedArtifacts.includes(`${packageName}:`),
        `${label} omits ${packageName}`
      );
    }
  }
}

export function assertV5PresetOutputs(
  outputs: readonly Output[],
  label: string,
  requiredLabels: readonly string[],
  requiredPresetLabels: readonly string[]
): void {
  const outputByLabel = new Map(
    outputs.map((output) => [output.label, output])
  );
  assertContract(
    outputByLabel.size === outputs.length,
    `${label} contains duplicate JS artifact labels`
  );
  for (const requiredLabel of requiredLabels) {
    assertContract(
      outputByLabel.has(requiredLabel),
      `${label} is missing required JS artifact ${requiredLabel}`
    );
  }
  for (const requiredPresetLabel of requiredPresetLabels) {
    const output = outputByLabel.get(requiredPresetLabel);
    assertContract(
      output !== undefined,
      `${label} is missing required JS artifact ${requiredPresetLabel}`
    );
    const formatArtifacts = parsedArtifacts(
      outputExports(output.label, outputByLabel, new Set()),
      output.label
    );
    assertContract(
      formatArtifacts.length > 0,
      `${requiredPresetLabel} schema is absent`
    );
    resolveArtifacts(formatArtifacts, requiredPresetLabel);
  }
  const artifacts = outputs.flatMap((output) =>
    parsedArtifacts(
      outputExports(output.label, outputByLabel, new Set()),
      output.label
    )
  );
  assertContract(artifacts.length > 0, `${label} schema is absent`);
  resolveArtifacts(artifacts, label);
}
