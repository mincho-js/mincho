import { realpath, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
  assertDiamondPresetOrigins,
  assertDiamondSelectorsOnce,
  assertNoRuntimeGraph,
  assertV5PresetArtifact,
  assertV5PresetOutput,
  count,
  diamondPackageNames,
  diamondSelectors,
  presetExport
} from "./diamond-artifacts.js";
import type { PackedPackage, PackageManifest } from "./types.js";
import { PackageContractError } from "./types.js";
import { isRecord, readPackageManifest } from "./workspace.js";

function assertContract(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new PackageContractError(detail);
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("../"));
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(exportTargets);
}

function assertNoWorkspaceDependencySpecs(manifest: PackageManifest): void {
  for (const [name, specifier] of Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies
  })) {
    assertContract(
      !/^(?:workspace:|file:|link:|portal:)/.test(specifier),
      `${manifest.name} retains a workspace-path dependency: ${name} -> ${specifier}`
    );
  }
}

function assertStyleExport(manifest: PackageManifest): void {
  if (!isRecord(manifest.exports) || Array.isArray(manifest.exports)) {
    throw new PackageContractError(`${manifest.name} has no exports map for ./style.css`);
  }
  const style = manifest.exports["./style.css"];
  assertContract(
    exportTargets(style).some((target) => target.endsWith(".css")),
    `${manifest.name} is missing the ./style.css export`
  );
}

function assertPackageFiles(packageDirectory: string, manifest: PackageManifest): void {
  const targets = exportTargets(manifest.exports);
  assertContract(targets.length > 0, `${manifest.name} has no exported targets`);
  for (const target of targets) {
    assertContract(
      target.startsWith("./") && !target.includes(".."),
      `${manifest.name} has an unsafe export target: ${target}`
    );
    assertContract(
      existsSync(join(packageDirectory, target)),
      `${manifest.name} export is absent from packed files: ${target}`
    );
  }
  const typeTargets = [manifest.types, manifest.typings, ...targets].filter(
    (target): target is string => typeof target === "string" && /\.d\.(?:cts|mts|ts)$/.test(target)
  );
  assertContract(typeTargets.length > 0, `${manifest.name} exports no declaration file`);
  for (const target of typeTargets) {
    assertContract(
      existsSync(join(packageDirectory, target)),
      `${manifest.name} declaration file is absent: ${target}`
    );
  }
  if (manifest.files.some((entry) => entry.replace(/\/$/, "") === "dist")) {
    assertContract(existsSync(join(packageDirectory, "dist")), `${manifest.name} omits dist`);
  }
}

function installedPackageDirectory(consumerRoot: string, packageName: string): string {
  return join(consumerRoot, "node_modules", ...packageName.split("/"));
}

export async function assertInstalledPackageContract(options: {
  readonly consumerRoot: string;
  readonly packed: readonly PackedPackage[];
  readonly repoRoot: string;
}): Promise<void> {
  const repoRealpath = await realpath(options.repoRoot);
  for (const packed of options.packed) {
    const directory = installedPackageDirectory(options.consumerRoot, packed.manifest.name);
    const resolvedDirectory = await realpath(directory);
    assertContract(
      !inside(repoRealpath, resolvedDirectory),
      `${packed.manifest.name} resolves into the workspace: ${resolvedDirectory}`
    );
    const manifest = await readPackageManifest(join(directory, "package.json"));
    assertNoWorkspaceDependencySpecs(manifest);
    assertPackageFiles(directory, manifest);
    if (diamondPackageNames.has(manifest.name)) assertStyleExport(manifest);
  }
}

function assertFailure(
  label: string,
  action: () => void,
  expectedDetail: string
): void {
  try {
    action();
  } catch (error) {
    if (error instanceof PackageContractError) {
      assertContract(error.detail.includes(expectedDetail), `${label} diagnostic changed`);
      return;
    }
    throw error;
  }
  throw new PackageContractError(`Expected failure path did not fail: ${label}`);
}

export function assertVerifierFailurePaths(): void {
  assertFailure(
    "workspace-path dependency",
    () =>
      assertNoWorkspaceDependencySpecs({
        name: "@package-contract/bad-dependency",
        version: "0.0.0",
        private: false,
        dependencies: { "@mincho-js/css": "workspace:^" },
        optionalDependencies: {},
        exports: "./index.js",
        files: []
      }),
    "retains a workspace-path dependency"
  );
  assertFailure(
    "missing style export",
    () =>
      assertStyleExport({
        name: "@package-contract/missing-style",
        version: "0.0.0",
        private: false,
        dependencies: {},
        optionalDependencies: {},
        exports: { ".": "./index.js" },
        files: []
      }),
    "is missing the ./style.css export"
  );
  assertFailure(
    "non-record style exports",
    () =>
      assertStyleExport({
        name: "@package-contract/non-record-style",
        version: "0.0.0",
        private: false,
        dependencies: {},
        optionalDependencies: {},
        exports: [],
        files: []
      }),
    "has no exports map for ./style.css"
  );
  assertFailure(
    "missing package diamond selector",
    () => assertDiamondSelectorsOnce(".diamond_a_display {}", "failure fixture"),
    "selector count changed"
  );
  assertFailure(
    "incomplete V5 preset artifact",
    () =>
      assertV5PresetArtifact(
        { schema: "mincho.defineRulesPreset", version: 5 },
        "failure fixture"
      ),
    "Invalid defineRules preset"
  );
  assertFailure(
    "V5 preset version 50",
    () =>
      assertV5PresetOutput(
        '{ schema: "mincho.defineRulesPreset", version: 50 }',
        "failure fixture"
      ),
    "is not V5-only"
  );
  assertV5PresetOutput(
    '{ schema: "mincho.defineRulesPreset", version: 5, nodes: [] } const metadata = { version: 30 };',
    "V5 preset with unrelated version"
  );
  assertFailure(
    "legacy version in V5 preset",
    () =>
      assertV5PresetOutput(
        '{ schema: "mincho.defineRulesPreset", version: 4 }',
        "failure fixture"
      ),
    "is not V5-only"
  );
  assertNoRuntimeGraph(
    "const unrelated = { origin: 'local', nodes: [] };",
    "unrelated runtime metadata"
  );
}

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function artifactSources(
  root: string,
  extensions: readonly string[],
  label: string
): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const files = entries.filter((entry) =>
    extensions.some((extension) => entry.endsWith(extension))
  );
  assertContract(files.length > 0, `No ${label} artifacts found in ${root}`);
  return (await Promise.all(files.map((entry) => source(join(root, entry))))).join("\n");
}

async function cssSources(root: string): Promise<string> {
  return artifactSources(root, [".css"], "CSS");
}

async function jsSources(root: string): Promise<string> {
  return artifactSources(root, [".js", ".mjs", ".cjs"], "JS");
}

async function packageDiamondCssSources(consumerRoot: string): Promise<string> {
  return (
    await Promise.all(
      diamondSelectors.map(({ packageName }) =>
        source(join(installedPackageDirectory(consumerRoot, packageName), "dist", "style.css"))
      )
    )
  ).join("\n");
}

export async function assertBuildArtifacts(options: {
  readonly consumerRoot: string;
}): Promise<void> {
  const viteRoot = join(options.consumerRoot, "fixture", "vite", "dist");
  const esbuildRoot = join(options.consumerRoot, "fixture", "esbuild", "dist");
  const [viteStatic, viteJs, viteCss, esbuildJs, esbuildCjs, esbuildCss] =
    await Promise.all([
      source(join(viteRoot, "esm", "static.mjs")),
      jsSources(viteRoot),
      cssSources(viteRoot),
      source(join(esbuildRoot, "index.js")),
      source(join(esbuildRoot, "cjs.js")),
      cssSources(esbuildRoot)
    ]);
  const sharedRoot = installedPackageDirectory(
    options.consumerRoot,
    "@examples/shared-component"
  );
  const diamondPresetEntrypoint = join(
    installedPackageDirectory(options.consumerRoot, "@mincho-js-proof/diamond-d"),
    "dist",
    "preset.js"
  );
  const sharedPresetEntrypoint = join(sharedRoot, "dist", "esm", "preset.mjs");
  const vitePresetEntrypoints = [join(viteRoot, "esm", "preset.mjs"), join(viteRoot, "cjs", "preset.cjs")] as const;
  const [
    sharedRuntime,
    sharedPreset,
    sharedCss,
    diamondRuntime,
    diamondPreset,
    packageCss,
    diamondArtifact,
    sharedArtifact,
    viteEsmArtifact,
    viteCjsArtifact
  ] = await Promise.all([
    source(join(sharedRoot, "dist", "esm", "index.mjs")),
    source(sharedPresetEntrypoint),
    source(join(sharedRoot, "dist", "style.css")),
    source(join(installedPackageDirectory(options.consumerRoot, "@mincho-js-proof/diamond-d"), "dist", "index.js")),
    source(diamondPresetEntrypoint),
    packageDiamondCssSources(options.consumerRoot),
    presetExport("@mincho-js-proof/diamond-d/preset", "diamond-d preset", options.consumerRoot),
    presetExport("@examples/shared-component/preset", "shared-component preset", options.consumerRoot),
    presetExport(vitePresetEntrypoints[0], "Vite ESM preset", options.consumerRoot),
    presetExport(vitePresetEntrypoints[1], "Vite CommonJS preset", options.consumerRoot)
  ]);

  assertDiamondSelectorsOnce(packageCss, "installed package diamond CSS");
  assertDiamondSelectorsOnce(viteCss, "Vite consumer CSS");
  assertDiamondSelectorsOnce(esbuildCss, "esbuild consumer CSS");
  assertContract(count(sharedCss, "rebeccapurple") === 1, "ancestor selector count changed");
  assertContract(count(viteCss, "tomato") === 1, "Vite local selector count changed");
  assertV5PresetOutput(diamondPreset, "diamond-d preset", true);
  assertV5PresetOutput(sharedPreset, "shared-component preset");
  assertV5PresetOutput(viteJs, "Vite preset");
  assertDiamondPresetOrigins(assertV5PresetArtifact(diamondArtifact, "diamond-d preset"), "diamond-d preset");
  assertV5PresetArtifact(sharedArtifact, "shared-component preset");
  assertV5PresetArtifact(viteEsmArtifact, "Vite ESM preset");
  assertV5PresetArtifact(viteCjsArtifact, "Vite CommonJS preset");
  assertNoRuntimeGraph(diamondRuntime, "diamond-d runtime");
  assertNoRuntimeGraph(sharedRuntime, "shared-component runtime");
  assertNoRuntimeGraph(viteStatic, "static cx output");
  assertNoRuntimeGraph(esbuildJs, "esbuild runtime");
  assertNoRuntimeGraph(esbuildCjs, "esbuild CommonJS runtime");
  assertContract(
    esbuildCjs.includes("SharedExampleCard"),
    "esbuild did not consume the shared-component CommonJS entry"
  );
  assertContract(/['"]?classWrites['"]?\s*:/.test(viteJs), "dynamic cx table is absent");
  assertContract(/['"]?segments['"]?\s*:/.test(viteJs), "dynamic cx segments are absent");
  assertContract(!/['"]?classWrites['"]?\s*:/.test(viteStatic), "static cx retained a dynamic table");
  assertContract(!/['"]?segments['"]?\s*:/.test(viteStatic), "static cx retained dynamic segments");
  assertContract(esbuildCss.includes("rebeccapurple"), "esbuild did not emit the explicit ./style.css export");
}
