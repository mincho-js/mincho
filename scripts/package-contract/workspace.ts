import {
  mkdir,
  readdir,
  readFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./process.js";
import type { PackedPackage, PackageManifest, WorkspacePackage } from "./types.js";
import { PackageContractError } from "./types.js";

const seeds = [
  "@examples/shared-component",
  "@mincho-js/vite",
  "@mincho-js/esbuild"
] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return Object.fromEntries(entries);
}

export function parsePackageManifest(value: unknown, source: string): PackageManifest {
  if (!isRecord(value) || typeof value["name"] !== "string") {
    throw new PackageContractError(`Invalid package manifest: ${source}`);
  }
  if (typeof value["version"] !== "string") {
    throw new PackageContractError(`Package manifest has no version: ${source}`);
  }
  const files = Array.isArray(value["files"])
    ? value["files"].filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    name: value["name"],
    version: value["version"],
    private: value["private"] === true,
    dependencies: stringRecord(value["dependencies"]),
    optionalDependencies: stringRecord(value["optionalDependencies"]),
    exports: value["exports"],
    files,
    types: typeof value["types"] === "string" ? value["types"] : undefined,
    typings: typeof value["typings"] === "string" ? value["typings"] : undefined
  };
}

export async function readPackageManifest(path: string): Promise<PackageManifest> {
  const source = await readFile(path, "utf8");
  return parsePackageManifest(JSON.parse(source), path);
}

async function workspaceDirectories(repoRoot: string): Promise<string[]> {
  const roots = [join(repoRoot, "packages"), join(repoRoot, "examples")];
  const directories = await Promise.all(
    roots.map(async (root) => {
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name));
    })
  );
  return directories.flat();
}

export async function collectWorkspaceClosure(
  repoRoot: string
): Promise<readonly WorkspacePackage[]> {
  const workspaces = new Map<string, WorkspacePackage>();
  for (const directory of await workspaceDirectories(repoRoot)) {
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = await readPackageManifest(manifestPath);
    workspaces.set(manifest.name, { directory, manifest });
  }

  const closure = new Map<string, WorkspacePackage>();
  const queue: string[] = [...seeds];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || closure.has(name)) continue;
    const workspace = workspaces.get(name);
    if (workspace === undefined) {
      throw new PackageContractError(`Workspace closure is missing ${name}`);
    }
    closure.set(name, workspace);
    for (const dependency of Object.keys({
      ...workspace.manifest.dependencies,
      ...workspace.manifest.optionalDependencies
    })) {
      if (workspaces.has(dependency)) queue.push(dependency);
    }
  }
  return [...closure.values()].sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name)
  );
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(path)));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

async function assertFreshReleasePayload(workspace: WorkspacePackage): Promise<void> {
  const release = join(workspace.directory, "_release", "package");
  const sourceDist = join(workspace.directory, "dist");
  const releaseDist = join(release, "dist");
  if (!existsSync(release) || !existsSync(releaseDist)) {
    throw new PackageContractError(
      `Missing release payload for ${workspace.manifest.name}: ${release}`
    );
  }
  if (!existsSync(sourceDist)) {
    throw new PackageContractError(
      `Missing source dist for ${workspace.manifest.name}: ${sourceDist}`
    );
  }
  for (const sourceFile of await walkFiles(sourceDist)) {
    const relativePath = sourceFile.slice(sourceDist.length + 1);
    const releasedFile = join(releaseDist, relativePath);
    if (!existsSync(releasedFile)) {
      throw new PackageContractError(
        `Stale release payload for ${workspace.manifest.name}: missing ${releasedFile}`
      );
    }
    const [source, released] = await Promise.all([
      readFile(sourceFile),
      readFile(releasedFile)
    ]);
    if (!source.equals(released)) {
      throw new PackageContractError(
        `Stale release payload for ${workspace.manifest.name}: ${relativePath}`
      );
    }
  }
}

function archiveName(workspace: WorkspacePackage): string {
  return `${workspace.manifest.name.replace(/\//g, "-").replace("@", "")}-${workspace.manifest.version}.tgz`;
}

async function singleArchive(directory: string): Promise<string> {
  const archives = (await readdir(directory)).filter((entry) => entry.endsWith(".tgz"));
  if (archives.length !== 1 || archives[0] === undefined) {
    throw new PackageContractError(`Expected one archive in ${directory}`);
  }
  return join(directory, archives[0]);
}

export async function packWorkspaceClosure(
  repoRoot: string,
  tempRoot: string,
  workspaces: readonly WorkspacePackage[]
): Promise<readonly PackedPackage[]> {
  const packedRoot = join(tempRoot, "packed");
  await mkdir(packedRoot, { recursive: true });
  const packed: PackedPackage[] = [];
  for (const workspace of workspaces) {
    const packageDirectory = join(packedRoot, workspace.manifest.name.replace(/\//g, "-"));
    await mkdir(packageDirectory);
    const expectedArchivePath = join(packageDirectory, archiveName(workspace));
    let archivePath = expectedArchivePath;
    if (workspace.manifest.private) {
      await runCommand({
        command: "yarn",
        args: ["workspace", workspace.manifest.name, "pack", "--out", expectedArchivePath],
        cwd: repoRoot,
        artifactPath: expectedArchivePath
      });
    } else {
      await assertFreshReleasePayload(workspace);
      const release = join(workspace.directory, "_release", "package");
      await runCommand({
        command: "npm",
        args: ["pack", release, "--pack-destination", packageDirectory],
        cwd: repoRoot,
        artifactPath: release
      });
      archivePath = await singleArchive(packageDirectory);
    }
    packed.push({ ...workspace, archivePath });
  }
  return packed;
}
