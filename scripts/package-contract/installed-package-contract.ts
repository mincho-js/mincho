import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { installedPackageDirectory } from "./artifact-sources.js";
import { diamondPackageNames } from "./diamond-artifacts.js";
import type { PackedPackage, PackageManifest } from "./types.js";
import { PackageContractError } from "./types.js";
import { readPackageManifest } from "./workspace.js";

function assertContract(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new PackageContractError(detail);
}

function assertRecord(
  value: unknown,
  detail: string
): asserts value is Readonly<Record<string, unknown>> {
  assertContract(
    typeof value === "object" && value !== null && !Array.isArray(value),
    detail
  );
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(exportTargets);
}

export function assertNoWorkspaceDependencySpecs(
  manifest: PackageManifest
): void {
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

export function assertStyleExport(manifest: PackageManifest): void {
  assertRecord(
    manifest.exports,
    `${manifest.name} has no exports map for ./style.css`
  );
  const style = manifest.exports["./style.css"];
  assertContract(
    exportTargets(style).some((target) => target.endsWith(".css")),
    `${manifest.name} is missing the ./style.css export`
  );
}

function assertPackageFiles(
  packageDirectory: string,
  manifest: PackageManifest
): void {
  const targets = exportTargets(manifest.exports);
  assertContract(
    targets.length > 0,
    `${manifest.name} has no exported targets`
  );
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
    (target): target is string =>
      typeof target === "string" && /\.d\.(?:cts|mts|ts)$/.test(target)
  );
  assertContract(
    typeTargets.length > 0,
    `${manifest.name} exports no declaration file`
  );
  for (const target of typeTargets) {
    assertContract(
      existsSync(join(packageDirectory, target)),
      `${manifest.name} declaration file is absent: ${target}`
    );
  }
  if (manifest.files.some((entry) => entry.replace(/\/$/, "") === "dist")) {
    assertContract(
      existsSync(join(packageDirectory, "dist")),
      `${manifest.name} omits dist`
    );
  }
}

export async function assertInstalledPackageContract(options: {
  readonly consumerRoot: string;
  readonly packed: readonly PackedPackage[];
  readonly repoRoot: string;
}): Promise<void> {
  const repoRealpath = await realpath(options.repoRoot);
  for (const packed of options.packed) {
    const directory = installedPackageDirectory(
      options.consumerRoot,
      packed.manifest.name
    );
    const resolvedDirectory = await realpath(directory);
    const workspaceRelativePath = relative(repoRealpath, resolvedDirectory);
    assertContract(
      workspaceRelativePath === ".." || workspaceRelativePath.startsWith("../"),
      `${packed.manifest.name} resolves into the workspace: ${resolvedDirectory}`
    );
    const manifest = await readPackageManifest(join(directory, "package.json"));
    assertNoWorkspaceDependencySpecs(manifest);
    assertPackageFiles(directory, manifest);
    if (diamondPackageNames.has(manifest.name)) assertStyleExport(manifest);
  }
}
