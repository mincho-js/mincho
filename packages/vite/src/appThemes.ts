import type { ResolvedConfig, Rollup } from "vite";
import {
  internalReadStaticStringExport,
  internalReadStaticStringExportGraph
} from "@mincho-js/integration";
import type { MinchoSsrCssManifest } from "./ssr.js";
import { createSsrModuleKey } from "./ssrCssManifest.js";
import type { MinchoThemeSelector } from "./themeTypes.js";

export interface MinchoAppThemesOptions {
  entries: readonly ({ id: string; entry: string } & (
    | { classNameExport?: string; attribute?: never; value?: never }
    | { attribute: string; value: string; classNameExport?: never }
  ))[];
  default: string;
  system?: { light: string; dark: string };
  /** Explicit CSS color-scheme contract; enables the conditional color-only pass. */
  colorScheme?: { light: string; dark: string; inheritance: "uniform" };
}

export function createAppThemes(options?: MinchoAppThemesOptions) {
  const modules = new Map<string, string>();
  let config: ResolvedConfig;
  let active = false;
  return {
    configure(value: ResolvedConfig, mode: string | undefined) {
      config = value;
      active = !!options && !config.build.ssr;
      if (!options) return;
      if (
        config.build.lib ||
        mode !== "dist-chunk" ||
        !config.build.cssCodeSplit
      )
        throw new Error(
          "appCss.themes requires an application dist-chunk build with cssCodeSplit."
        );
      const ids = new Set<string>();
      if (options.colorScheme && options.colorScheme.inheritance !== "uniform")
        throw new Error(
          "Theme color compaction requires uniform color-scheme inheritance."
        );
      for (const entry of options.entries) {
        if (
          !entry.id ||
          entry.id === "system" ||
          ids.has(entry.id) ||
          !entry.entry
        )
          throw new Error(
            "Theme entries require unique non-empty ids (system is reserved) and module paths."
          );
        if (
          entry.attribute !== undefined &&
          (!/^data-[a-z][a-z0-9-]*$/.test(entry.attribute) ||
            !entry.value ||
            /["'<>]/.test(entry.value) ||
            [...entry.value].some((character) => character.charCodeAt(0) < 32))
        )
          throw new Error(
            "Theme attributes require a data-* name and a non-empty safe value."
          );
        ids.add(entry.id);
      }
      for (const id of [
        options.default,
        ...Object.values(options.system ?? {}),
        ...(options.colorScheme
          ? [options.colorScheme.light, options.colorScheme.dark]
          : [])
      ])
        if (!ids.has(id)) throw new Error(`Unknown configured theme: ${id}`);
    },
    async start(context: Rollup.PluginContext) {
      modules.clear();
      if (!active || !options || config.command !== "build") return;
      for (const entry of options.entries) {
        const resolved = await context.resolve(
          entry.entry.startsWith(".") || entry.entry.startsWith("/")
            ? entry.entry
            : `./${entry.entry}`,
          `${config.root}/index.html`
        );
        if (!resolved || resolved.external)
          throw new Error(`Unable to resolve theme entry: ${entry.entry}`);
        modules.set(entry.id, resolved.id);
        context.emitFile({
          type: "chunk",
          id: resolved.id,
          name: `mincho-theme-${entry.id.replace(/[^\w-]/g, "-")}`,
          preserveSignature: "strict"
        });
      }
    },
    async colorContract(context: Rollup.PluginContext) {
      if (!options?.colorScheme) return;
      const read = async (id: string) => {
        const entry = options.entries.find((entry) => entry.id === id);
        if (!entry || entry.attribute) return;
        return internalReadStaticStringExportGraph(
          modules.get(id)!,
          entry.classNameExport ?? "themeClass",
          {
            source: (moduleId) =>
              context.getModuleInfo(moduleId)?.code ?? undefined,
            resolve: async (importer, source) => {
              const result = await context.resolve(source, importer, {
                skipSelf: false
              });
              return result && !result.external ? result.id : undefined;
            }
          }
        );
      };
      const light = await read(options.colorScheme.light),
        dark = await read(options.colorScheme.dark);
      const targets = config.build.cssTarget;
      if (light && dark)
        return {
          light,
          dark,
          inheritance: options.colorScheme.inheritance,
          targets: typeof targets === "string" ? [targets] : targets || []
        };
    },
    async attach(
      context: Rollup.PluginContext,
      manifest: MinchoSsrCssManifest,
      bundle: Rollup.OutputBundle
    ): Promise<MinchoSsrCssManifest> {
      if (!active || !options) return manifest;
      const entries: Record<
        string,
        { css: readonly string[]; selector: MinchoThemeSelector }
      > = Object.create(null);
      const moduleKey = await createSsrModuleKey(config.root);
      for (const entry of options.entries) {
        const id = modules.get(entry.id)!;
        const key = moduleKey(id);
        const css =
          key === undefined
            ? undefined
            : (manifest.modules[key] ?? manifest.entries[key]);
        if (!css)
          throw new Error(
            `Theme module missing from the client CSS manifest: ${entry.id}`
          );
        let selector: MinchoThemeSelector;
        if (entry.attribute !== undefined)
          selector = { attribute: entry.attribute, value: entry.value };
        else {
          const entryChunk = Object.values(bundle).find(
            (item): item is Rollup.OutputChunk =>
              item.type === "chunk" && item.facadeModuleId === id
          );
          const className =
            internalReadStaticStringExport(
              context.getModuleInfo(id)?.code ?? "",
              entry.classNameExport ?? "themeClass"
            ) ??
            (await internalReadStaticStringExportGraph(
              id,
              entry.classNameExport ?? "themeClass",
              {
                source: (moduleId) =>
                  context.getModuleInfo(moduleId)?.code ?? undefined,
                resolve: async (importer, source) => {
                  const result = await context.resolve(source, importer, {
                    skipSelf: false
                  });
                  return result && !result.external ? result.id : undefined;
                }
              }
            )) ??
            (entryChunk &&
              internalReadStaticStringExport(
                entryChunk.code,
                entry.classNameExport ?? "themeClass"
              ));
          if (!className || !/^[A-Za-z_][\w-]*$/.test(className))
            throw new Error(
              `Theme ${entry.id} must export a statically extracted class string as ${entry.classNameExport ?? "themeClass"}.`
            );
          selector = { className };
        }
        entries[entry.id] = { css, selector };
      }
      return {
        ...manifest,
        version: 2,
        themes: { default: options.default, system: options.system, entries }
      };
    }
  };
}
