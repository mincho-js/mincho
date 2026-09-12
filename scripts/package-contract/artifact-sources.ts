import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { diamondSelectors } from "./diamond-artifacts.js";
import { PackageContractError } from "./types.js";

function assertContract(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new PackageContractError(detail);
}

export function installedPackageDirectory(
  consumerRoot: string,
  packageName: string
): string {
  const loader = join(consumerRoot, ".pnp.cjs");

  if (existsSync(loader)) {
    // Use the isolated consumer's resolver without installing its global hooks
    // over this verifier's workspace PnP instance.
    const pnp = createRequire(import.meta.url)(loader) as {
      resolveToUnqualified(request: string, issuer: string): string;
    };

    return pnp.resolveToUnqualified(
      packageName,
      join(consumerRoot, "package.json")
    );
  }

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
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(
    (entry) =>
      entry.isFile() &&
      extensions.some((extension) => entry.name.endsWith(extension))
  );

  assertContract(files.length > 0, `No ${label} artifacts found in ${root}`);

  return (
    await Promise.all(
      files.map((entry) => source(join(entry.parentPath, entry.name)))
    )
  ).join("\n");
}

export async function cssSources(root: string): Promise<string> {
  return artifactSources(root, [".css"], "CSS");
}

export async function jsSources(
  root: string
): Promise<readonly { readonly label: string; readonly source: string }[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(
    (entry) => entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)
  );

  assertContract(files.length > 0, `No JS artifacts found in ${root}`);

  return Promise.all(
    files.map(async (entry) => ({
      label: relative(root, join(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
      source: await source(join(entry.parentPath, entry.name))
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
