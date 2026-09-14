import { createRequire } from "node:module";

/** Resolve from the caller's module so strict PnP uses its declared dependencies. */
export function resolveFromModule(
  importer: string | URL,
  specifier: string
): string {
  return createRequire(importer).resolve(specifier);
}
