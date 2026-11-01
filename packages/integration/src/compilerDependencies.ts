import { internalResolveFromModule as resolveFromModule } from "@mincho-js/babel";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { dirname, join } from "node:path";

interface CompilerPackage {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

async function privatePackageManifest(
  issuer: string,
  name: string
): Promise<string> {
  const pnp = (
    Module as typeof Module & {
      findPnpApi?: (path: string) => {
        resolveToUnqualified(request: string, issuer: string): string | null;
      } | null;
    }
  ).findPnpApi?.(issuer);
  if (pnp) {
    const directory = pnp.resolveToUnqualified(name, issuer);
    if (directory) {
      const manifest = join(directory, "package.json");
      try {
        // PnP can locate optional platform packages that were not installed.
        await readFile(manifest);
        return manifest;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } else {
    // Node's lookup paths also cover packages that export only subpaths.
    for (const directory of createRequire(issuer).resolve.paths(name) ?? []) {
      const manifest = join(directory, name, "package.json");
      try {
        await readFile(manifest);
        return manifest;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  throw Object.assign(new Error(`Cannot resolve compiler dependency ${name}`), {
    code: "MODULE_NOT_FOUND"
  });
}

async function packageManifest(file: string): Promise<string> {
  let directory = dirname(file);
  while (true) {
    const manifest = join(directory, "package.json");
    try {
      const value = JSON.parse(await readFile(manifest, "utf8"));
      // Build directories can contain a package.json that only sets `type`.
      if (typeof value.name === "string" && typeof value.version === "string")
        return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`Cannot identify compiler package for ${file}`);
    directory = parent;
  }
}

/** Resolve from each issuer, including PnP peer contexts, without hashing checkout paths. */
export async function fingerprintCompilerDependencies(
  entries: readonly string[],
  resolve: typeof resolveFromModule = resolveFromModule
): Promise<string> {
  const manifests = new Map<string, number>();
  const packages: unknown[] = [];
  const visit = async (manifest: string): Promise<number> => {
    const previous = manifests.get(manifest);
    if (previous !== undefined) return previous;
    const index = manifests.size;
    manifests.set(manifest, index);
    const value: CompilerPackage = JSON.parse(await readFile(manifest, "utf8"));
    const dependencies = {
      ...value.peerDependencies,
      ...value.dependencies,
      ...value.optionalDependencies
    };
    const edges: [string, number | null][] = [];
    packages[index] = [value.name, value.version, edges];
    for (const name of Object.keys(dependencies).sort()) {
      const optional =
        Object.hasOwn(value.optionalDependencies ?? {}, name) ||
        (!Object.hasOwn(value.dependencies ?? {}, name) &&
          value.peerDependenciesMeta?.[name]?.optional === true);
      let dependency: string;
      try {
        try {
          dependency = resolve(manifest, `${name}/package.json`);
        } catch {
          try {
            dependency = await packageManifest(resolve(manifest, name));
          } catch (error) {
            if (
              !["ERR_PACKAGE_PATH_NOT_EXPORTED", "MODULE_NOT_FOUND"].includes(
                (error as NodeJS.ErrnoException).code ?? ""
              )
            )
              throw error;
            try {
              dependency = await privatePackageManifest(manifest, name);
            } catch (fallbackError) {
              if (
                (fallbackError as NodeJS.ErrnoException).code ===
                "MODULE_NOT_FOUND"
              )
                throw error;
              throw fallbackError;
            }
          }
        }
      } catch (error) {
        if (
          !optional ||
          (error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND"
        )
          throw error;
        edges.push([name, null]);
        continue;
      }
      edges.push([name, await visit(dependency)]);
    }
    return index;
  };
  const roots: number[] = [];
  for (const entry of entries)
    roots.push(await visit(await packageManifest(entry)));
  return createHash("sha256")
    .update(JSON.stringify([roots, packages]))
    .digest("hex");
}
