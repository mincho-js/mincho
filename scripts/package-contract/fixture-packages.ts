import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./process.js";
import type { PackedPackage } from "./types.js";
import { PackageContractError } from "./types.js";
import { readPackageManifest } from "./workspace.js";

const fixturePackages = [
  "@mincho-js-proof/diamond-a",
  "@mincho-js-proof/diamond-b",
  "@mincho-js-proof/diamond-c",
  "@mincho-js-proof/diamond-d"
] as const;

function packagePath(scriptRoot: string, packageName: string): string {
  return join(scriptRoot, "fixture", "packages", ...packageName.split("/"));
}

function archiveDirectoryName(packageName: string): string {
  return packageName.replace(/\//g, "-").replace("@", "");
}

async function singleArchive(directory: string): Promise<string> {
  const archives = (await readdir(directory)).filter((entry) => entry.endsWith(".tgz"));
  if (archives.length !== 1 || archives[0] === undefined) {
    throw new PackageContractError(`Expected one fixture archive in ${directory}`);
  }
  return join(directory, archives[0]);
}

export async function packFixturePackages(
  scriptRoot: string,
  tempRoot: string
): Promise<readonly PackedPackage[]> {
  const packedRoot = join(tempRoot, "packed-fixtures");
  await mkdir(packedRoot, { recursive: true });
  const packed: PackedPackage[] = [];
  for (const packageName of fixturePackages) {
    const directory = packagePath(scriptRoot, packageName);
    const packageDirectory = join(packedRoot, archiveDirectoryName(packageName));
    await mkdir(packageDirectory);
    await runCommand({
      command: "npm",
      args: ["pack", directory, "--pack-destination", packageDirectory],
      cwd: tempRoot,
      artifactPath: directory
    });
    packed.push({
      archivePath: await singleArchive(packageDirectory),
      directory,
      manifest: await readPackageManifest(join(directory, "package.json"))
    });
  }
  return packed;
}
