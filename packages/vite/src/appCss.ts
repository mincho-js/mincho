import type { MinchoCssChunkSharingOptions } from "@mincho-js/integration";
import { normalizePath } from "@rollup/pluginutils";
import { resolve } from "node:path";
import type { ConfigEnv, Rollup, UserConfig } from "vite";

export interface MinchoCssRoute {
  /** Stable router identity. Several routes may use the same entry module. */
  id: string;

  /** Module id or file relative to the Vite root. Must be in the built graph. */
  entry: string;

  /** Ancestor layout modules, from outermost to innermost. */
  layouts?: readonly string[];
}

export interface MinchoAppCssOptions {
  /** Native config by default; single sheet or Mincho rule generation per output chunk. */
  mode?: "native" | "single" | "dist-chunk";

  /** Opt-in whole-module prefix sharing. With routes, count distinct routes. */
  sharing?: MinchoCssChunkSharingOptions;

  /** Router manifest entries; their static dependencies determine CSS reach. */
  routes?: readonly MinchoCssRoute[];
}

export function validateAppCssOptions(options?: MinchoAppCssOptions): void {
  if (
    options?.mode !== undefined &&
    !["native", "single", "dist-chunk"].includes(options.mode)
  )
    throw new Error("appCss.mode must be native, single, or dist-chunk.");

  const ids = new Set<string>();

  for (const route of options?.routes ?? []) {
    if (!route.id || ids.has(route.id))
      throw new Error("appCss.routes must have non-empty, unique route ids.");
    if (!route.entry || route.layouts?.some((layout) => !layout))
      throw new Error("appCss.routes must reference non-empty module ids.");

    ids.add(route.id);
  }
}

export function appCssConfig(
  options: MinchoAppCssOptions | undefined,
  config: UserConfig,
  env: ConfigEnv
): UserConfig | undefined {
  if (
    env.command !== "build" ||
    config.build?.lib ||
    config.build?.ssr ||
    !options?.mode ||
    options.mode === "native"
  )
    return;

  const cssCodeSplit = options.mode === "dist-chunk";
  if (
    config.build?.cssCodeSplit !== undefined &&
    config.build.cssCodeSplit !== cssCodeSplit
  )
    throw new Error(
      `appCss.mode: ${JSON.stringify(options.mode)} conflicts with build.cssCodeSplit: ${config.build.cssCodeSplit}.`
    );

  return { build: { cssCodeSplit } };
}

/** Route reach is a selection policy, never a replacement for native edges. */
export async function collectCssRouteReach(
  routes: readonly MinchoCssRoute[],
  root: string,
  context: Pick<Rollup.PluginContext, "getModuleInfo" | "resolve">
): Promise<
  | { reach: Map<string, Set<string>>; missing: [] }
  | { reach?: undefined; missing: { route: string; module: string }[] }
> {
  const reach = new Map<string, Set<string>>();
  const missing: { route: string; module: string }[] = [];
  const resolvedIds = new Map<string, string | undefined>();

  const resolveModule = async (file: string) => {
    if (resolvedIds.has(file)) return resolvedIds.get(file);

    const candidate = context.getModuleInfo(file)
      ? file
      : normalizePath(resolve(root, file));

    const resolved = context.getModuleInfo(candidate)
      ? { id: candidate, external: false }
      : await context.resolve(candidate, undefined, { skipSelf: true });

    const info = resolved && context.getModuleInfo(resolved.id);
    const id =
      resolved &&
      !resolved.external &&
      info &&
      !info.isExternal &&
      info.isIncluded
        ? resolved.id
        : undefined;

    resolvedIds.set(file, id);

    return id;
  };

  for (const route of routes) {
    const visited = new Set<string>();

    const visit = (id: string) => {
      if (visited.has(id)) return;

      visited.add(id);

      const info = context.getModuleInfo(id);
      if (!info || info.isExternal) return;

      const consumers = reach.get(id) ?? new Set<string>();
      consumers.add(route.id);
      reach.set(id, consumers);

      // Dynamic descendants have their own loading boundary. In particular,
      // two optional widgets in one route must not count as two routes.
      for (const dependency of info.importedIds) visit(dependency);
    };

    for (const file of [...(route.layouts ?? []), route.entry]) {
      const id = await resolveModule(file);

      if (id) visit(id);
      else missing.push({ route: route.id, module: file });
    }
  }

  return missing.length ? { missing } : { reach, missing: [] };
}

export function routesForCssModules(
  modules: readonly string[],
  reach: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  const [first, ...rest] = modules;
  if (!first) return [];

  return [...(reach.get(first) ?? [])]
    .filter((route) => rest.every((id) => reach.get(id)?.has(route)))
    .sort();
}
