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
  usage?: import("@mincho-js/integration").ClosedAppUsageOptions;
  /** Client-build manifest for ordered SSR CSS selection; off by default. */
  ssrManifest?: boolean | string;

  /** Native config by default; single sheet or Mincho rule generation per output chunk. */
  mode?: "native" | "single" | "dist-chunk";

  /** Opt-in whole-module prefix sharing. With routes, count distinct routes. */
  sharing?: MinchoCssChunkSharingOptions;

  /** Router manifest entries; their static dependencies determine CSS reach. */
  routes?: readonly MinchoCssRoute[];

  /** Safe IR passes, enabled for production dist-chunk builds. */
  optimize?:
    | boolean
    | {
        scopedResourceAnalysis?: boolean;
        mergeRules?: boolean;
        pruneGenerated?: boolean;
        compactThemes?: boolean;

        /** Native graph sharing keeps existing thresholds and route boundaries. */
        shareAtoms?: boolean;

        /** Opt-in adjacent rules with identical ordered media/supports paths. */
        mergeConditionalRules?: boolean;

        /** Remove private compiler-owned animations; on in production dist-chunk. */
        pruneKeyframes?: boolean;

        /** Remove proven unused private selections; on in production dist-chunk. */
        pruneRecipes?: boolean;

        /** Experimental block-local sharing of repeated static theme literals. */
        internThemeValues?: boolean;
      };
}

export function resolveAppCssOptimization(
  options: MinchoAppCssOptions | undefined,
  production: boolean
) {
  const value = options?.optimize;
  if (
    options?.mode !== "dist-chunk" ||
    value === false ||
    (!production && value === undefined)
  )
    return undefined;

  const explicit = typeof value === "object" ? value : {};

  return {
    scopedResourceAnalysis: explicit.scopedResourceAnalysis ?? false,
    mergeRules: explicit.mergeRules ?? true,
    pruneGenerated: explicit.pruneGenerated ?? true,
    compactThemes: explicit.compactThemes ?? true,
    mergeConditionalRules: explicit.mergeConditionalRules ?? false,
    pruneKeyframes: explicit.pruneKeyframes ?? production,
    pruneRecipes: explicit.pruneRecipes ?? production,
    internThemeValues: explicit.internThemeValues ?? false,
    shareAtoms:
      options.sharing === false ? false : (explicit.shareAtoms ?? true)
  };
}

export function validateAppCssOptions(options?: MinchoAppCssOptions): void {
  if (
    options?.usage &&
    (options.usage.mode !== "closed" || options.mode !== "dist-chunk")
  )
    throw new Error(
      "appCss.usage requires mode closed and appCss.mode dist-chunk."
    );
  for (const entry of options?.usage?.preserve ?? [])
    if (!entry.module || entry.exports?.some((name) => !name))
      throw new Error(
        "appCss.usage.preserve requires module paths and non-empty export names."
      );
  const manifest = options?.ssrManifest;
  if (
    manifest !== undefined &&
    typeof manifest !== "boolean" &&
    (typeof manifest !== "string" ||
      !manifest ||
      manifest.startsWith("/") ||
      manifest.includes("\\") ||
      manifest
        .split("/")
        .some((part) => !part || part === ".." || part === "."))
  )
    throw new Error(
      "appCss.ssrManifest must be a boolean or an output-relative file name."
    );

  const optimization = options?.optimize;

  if (optimization !== undefined && typeof optimization !== "boolean") {
    if (
      !optimization ||
      typeof optimization !== "object" ||
      Array.isArray(optimization)
    )
      throw new Error(
        "appCss.optimize must be a boolean or an optimization options object."
      );

    for (const [name, value] of Object.entries(optimization))
      if (
        ![
          "scopedResourceAnalysis",
          "mergeRules",
          "pruneGenerated",
          "compactThemes",
          "shareAtoms",
          "mergeConditionalRules",
          "pruneKeyframes",
          "pruneRecipes",
          "internThemeValues"
        ].includes(name) ||
        (value !== undefined && typeof value !== "boolean")
      )
        throw new Error(`Invalid appCss.optimize option: ${name}.`);
  }

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
