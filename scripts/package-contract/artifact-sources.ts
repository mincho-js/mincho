import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { diamondSelectors } from "./diamond-artifacts.js";
import { PackageContractError } from "./types.js";

function assertContract(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new PackageContractError(detail);
}

export function installedPackageDirectory(
  consumerRoot: string,
  packageName: string
): string {
  return join(consumerRoot, "node_modules", ...packageName.split("/"));
}

export async function source(path: string): Promise<string> {
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
  return (
    await Promise.all(files.map((entry) => source(join(root, entry))))
  ).join("\n");
}

export async function cssSources(root: string): Promise<string> {
  return artifactSources(root, [".css"], "CSS");
}

export async function jsSources(
  root: string
): Promise<readonly { readonly label: string; readonly source: string }[]> {
  const entries = await readdir(root, { recursive: true });
  const files = entries.filter((entry) => /\.(?:c|m)?js$/.test(entry));
  assertContract(files.length > 0, `No JS artifacts found in ${root}`);
  return Promise.all(
    files.map(async (entry) => ({
      label: entry,
      source: await source(join(root, entry))
    }))
  );
}

export async function packageDiamondCssSources(
  consumerRoot: string
): Promise<string> {
  return (
    await Promise.all(
      diamondSelectors.map(({ packageName }) =>
        source(
          join(
            installedPackageDirectory(consumerRoot, packageName),
            "dist",
            "style.css"
          )
        )
      )
    )
  ).join("\n");
}
