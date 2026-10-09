import {
  internalIsShareableCss,
  internalPlanCssChunkSharing,
  internalResolveCssChunkSharingOptions,
  type InternalCssSharingBoundary,
  type InternalCssSharingGroup,
  type MinchoCssChunkSharingOptions
} from "@mincho-js/integration";
import { relative } from "node:path";
import { normalizePath, type ResolvedConfig, type Rollup } from "vite";
import {
  collectCssRouteReach,
  routesForCssModules,
  type MinchoCssRoute
} from "./appCss.js";

interface CssChunk {
  fileName: string;
  name: string;
  imports: string[];
  viteMetadata?: { importedCss: Set<string> };
}

const cssRequest =
  /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)(?:[?#]|$)/;

/** Vite still performs CSS transformation, extraction, hashing and HTML linking. */
export function createCssSharing(
  option?: MinchoCssChunkSharingOptions,
  report: (detail: unknown) => void = () => {},
  routes?: readonly MinchoCssRoute[]
) {
  const options = internalResolveCssChunkSharingOptions(option);
  const sources = new Map<string, { source: string; owned: boolean }>();
  let config: ResolvedConfig;
  let enabled = false;
  let groups: InternalCssSharingGroup[] = [];
  let routeReach: Map<string, Set<string>> | undefined;
  let assignment = new Map<string, string>();
  let barriers = new WeakMap<
    object,
    { arrived: number; promise: Promise<void>; done(): void }
  >();

  const pending = new Set<() => void>();

  const abort = () => {
    pending.forEach((done) => done());
    pending.clear();
    barriers = new WeakMap();
  };

  return {
    configure(resolved: ResolvedConfig) {
      config = resolved;
      enabled = Boolean(
        options &&
        config.command === "build" &&
        !config.build.lib &&
        !config.build.ssr &&
        config.build.cssCodeSplit &&
        (!Array.isArray(config.build.rollupOptions.output) ||
          config.build.rollupOptions.output.length <= 1)
      );
    },

    begin() {
      abort();
      groups = [];
      routeReach = undefined;
      assignment = new Map();
      // Keep unchanged module sources: Rollup can reuse transforms in watch mode.
    },

    record(id: string, source: string, owned: boolean) {
      if (enabled && cssRequest.test(id)) sources.set(id, { source, owned });
    },

    async plan(
      context: Pick<
        Rollup.PluginContext,
        "getModuleIds" | "getModuleInfo" | "getWatchFiles" | "warn" | "resolve"
      > & { environment?: { config: { consumer: string } } }
    ) {
      if (
        !enabled ||
        !options ||
        context.environment?.config.consumer === "server"
      ) {
        if (options) report({ applied: false, reason: "unsupported-build" });

        return;
      }

      const ids = [...context.getModuleIds()];
      const cssIds = ids.filter((id) => cssRequest.test(id));
      const opaqueTransforms =
        Boolean(config.css.postcss || config.css.lightningcss) ||
        config.plugins.some(
          (plugin) =>
            plugin.transform &&
            !nativeTransforms.has(plugin.name) &&
            plugin.name !== "mincho-css-vite" &&
            plugin.name !== "mincho:jsx-runtime-provenance" &&
            plugin.name !== "mincho:jsx-runtime-guards" &&
            !excludesCss(plugin.transform, cssIds)
        ) ||
        context
          .getWatchFiles()
          .some((id) =>
            /(?:^|[/\\])(?:postcss\.config\.[^/\\]+|\.postcssrc(?:\.[^/\\]+)?)$/.test(
              id
            )
          );

      if (opaqueTransforms) {
        report({ applied: false, reason: "opaque-css-transform" });
        context.warn(
          "[mincho] CSS sharing skipped: custom CSS transforms have no module ownership proof."
        );

        return;
      }

      if (routes) {
        const result = await collectCssRouteReach(routes, config.root, context);

        if (!result.reach) {
          report({
            applied: false,
            reason: "unresolved-route-modules",
            missing: result.missing
          });
          context.warn(
            "[mincho] CSS sharing skipped: appCss.routes references modules outside the built graph."
          );

          return;
        }

        routeReach = result.reach;
      }

      const live = new Set(ids);
      const modules = new Map<string, { bytes: number; shareable: boolean }>();

      for (const id of ids) {
        if (!cssRequest.test(id)) continue;

        const input = sources.get(id);
        modules.set(id, {
          bytes: input ? Buffer.byteLength(input.source) : 0,
          shareable: Boolean(
            input &&
            (input.owned ||
              (!id.includes("node_modules") &&
                !id.startsWith("\0") &&
                id.endsWith(".css") &&
                !id.endsWith(".module.css"))) &&
            internalIsShareableCss(input.source)
          )
        });
      }

      const boundaries: InternalCssSharingBoundary[] = [];

      for (const id of ids) {
        const info = context.getModuleInfo(id);
        if (!info || (!info.isEntry && !info.dynamicImporters.length)) continue;

        const visited = new Set<string>();
        const ordered: string[] = [];

        const visit = (moduleId: string) => {
          if (visited.has(moduleId)) return;

          visited.add(moduleId);

          const module = context.getModuleInfo(moduleId);
          if (!module || module.isExternal) return;

          for (const dependency of module.importedIds) visit(dependency);

          if (modules.has(moduleId)) ordered.push(moduleId);
        };

        visit(id);
        boundaries.push({ id, modules: ordered });
      }

      groups = internalPlanCssChunkSharing(
        boundaries,
        modules,
        routeReach ? { ...options, minBoundaries: 2 } : options,
        routeReach
          ? (ids) =>
              routesForCssModules(ids, routeReach!).length >=
              options.minBoundaries
          : undefined,
        (id) => normalizePath(relative(config.root, id))
      );

      if (!groups.length)
        report({
          applied: false,
          reason: routeReach
            ? "no-eligible-route-prefix"
            : "no-eligible-prefix",
          thresholds: options
        });

      assignment = new Map(
        groups.flatMap((group) => group.modules.map((id) => [id, group.name]))
      );

      for (const id of sources.keys()) if (!live.has(id)) sources.delete(id);
    },

    outputOptions(output: Rollup.OutputOptions): Rollup.OutputOptions | null {
      if (
        !enabled ||
        !groups.length ||
        output.manualChunks ||
        output.preserveModules ||
        output.inlineDynamicImports ||
        (output.format !== "es" && output.format !== "cjs")
      ) {
        if (groups.length)
          report({ applied: false, reason: "custom-output-layout" });

        assignment = new Map();

        return null;
      }

      report({
        applied: true,
        reason: routeReach ? "ordered-route-prefix" : "ordered-prefix",
        groups: groups.map((group) =>
          routeReach
            ? {
                ...group,
                routes: routesForCssModules(group.modules, routeReach)
              }
            : group
        )
      });

      return {
        ...output,

        manualChunks(id) {
          return assignment.get(id);
        },

        onlyExplicitManualChunks: true
      };
    },

    async renderChunk(chunk: CssChunk, chunks: Record<string, CssChunk>) {
      if (!assignment.size) return;

      let barrier = barriers.get(chunks);

      if (!barrier) {
        let done!: () => void;
        const promise = new Promise<void>((resolve) => {
          done = resolve;
        });

        barrier = { arrived: 0, done, promise };
        barriers.set(chunks, barrier);
        pending.add(done);
      }

      barrier.arrived++;

      if (barrier.arrived === Object.keys(chunks).length) {
        const names = new Set(groups.map((group) => group.name));

        // Vite's pure-CSS cleanup later appends imported CSS. Seed shared CSS
        // first now so Set insertion order remains shared -> private in HTML,
        // manifests, and dynamic-import preload dependency lists.
        for (const current of Object.values(chunks)) {
          const shared: string[] = [];

          for (const imported of current.imports) {
            const dependency = chunks[imported];

            if (dependency && names.has(dependency.name))
              shared.push(...(dependency.viteMetadata?.importedCss ?? []));
          }

          const css = current.viteMetadata?.importedCss;

          if (css && shared.length) {
            const own = [...css];
            css.clear();

            for (const id of [...shared, ...own]) css.add(id);
          }
        }

        pending.delete(barrier.done);
        barrier.done();
      }

      await barrier.promise;
      void chunk;
    },

    abort
  };
}

// Vite 7 native CSS processing is covered by native build tests. A third-party
// plugin does not become trusted merely by choosing a `vite:` name.
const nativeTransforms = new Set([
  "vite:css",
  "vite:css-post",
  "vite:esbuild",
  "vite:json",
  "vite:worker",
  "vite:define",
  "vite:build-html",
  "vite:worker-import-meta-url",
  "vite:asset-import-meta-url",
  "vite:dynamic-import-vars",
  "vite:import-glob",
  "vite:build-import-analysis",
  "vite:reporter"
]);

/** Only a declared regular-expression filter proves CSS cannot be transformed. */
function excludesCss(hook: unknown, ids: string[]): boolean {
  if (!hook || typeof hook !== "object") return false;

  const filter = (hook as { filter?: { id?: unknown } }).filter?.id;
  if (!filter) return false;

  const matches = (patterns: unknown, id: string): boolean | undefined => {
    const values = Array.isArray(patterns) ? patterns : [patterns];
    if (!values.length || !values.every((value) => value instanceof RegExp))
      return;

    return values.some((value: RegExp) =>
      new RegExp(value.source, value.flags.replace(/[gy]/g, "")).test(id)
    );
  };

  const selection =
    filter instanceof RegExp || Array.isArray(filter)
      ? { include: filter, exclude: undefined }
      : (filter as { include?: unknown; exclude?: unknown });

  return ids.every(
    (id) =>
      matches(selection.include, id) === false ||
      matches(selection.exclude, id) === true
  );
}
