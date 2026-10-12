import { createHash } from "node:crypto";
import { normalizePath } from "@rollup/pluginutils";
import {
  internalGenerateVanillaCss,
  type InternalVanillaCssArtifact
} from "@mincho-js/integration";
import { version, type Plugin, type ResolvedConfig, type Rollup } from "vite";
import { excludesCss, nativeTransforms } from "./cssSharing.js";

const prefix = "\0mincho-style-marker:";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type Transform = Extract<
  NonNullable<Plugin["transform"]>,
  (...args: never[]) => unknown
>;

function transform(plugin: Plugin | undefined): Transform | undefined {
  const hook = plugin?.transform;

  return typeof hook === "function" ? hook : hook?.handler;
}

interface Artifact {
  origin: string;
  data: InternalVanillaCssArtifact;
}

/** One instance per Vite environment. Only output hooks serialize final CSS. */
export function createDistChunkCss(
  report: (phase: string, detail: unknown) => void
) {
  const artifacts = new Map<string, Artifact>();
  const owners = new Map<string, Set<string>>();
  let config: ResolvedConfig;
  let enabled = false;
  let cssTransform: Transform | undefined;
  let cssPostTransform: Transform | undefined;
  let outputNumber = 0;
  let outputs = new WeakMap<object, number>();
  let chunks: Record<string, Rollup.RenderedChunk> | undefined;

  const clearOwner = (owner: string) => {
    const previous = owners.get(owner);
    owners.delete(owner);

    for (const id of previous ?? [])
      if (![...owners.values()].some((ids) => ids.has(id)))
        artifacts.delete(id);
  };

  return {
    get enabled() {
      return enabled;
    },

    get chunks() {
      return chunks;
    },

    configure(resolved: ResolvedConfig, active: boolean) {
      config = resolved;
      enabled =
        active &&
        config.command === "build" &&
        !config.build.lib &&
        !config.build.ssr;

      if (!enabled) return;

      cssTransform = transform(
        config.plugins.find((plugin) => plugin.name === "vite:css")
      );
      cssPostTransform = transform(
        config.plugins.find((plugin) => plugin.name === "vite:css-post")
      );

      if (version !== "7.3.3" || !cssTransform || !cssPostTransform)
        throw new Error(
          `[mincho] dist-chunk requires the validated Vite 7.3.3 CSS adapter (found ${version}). Use appCss.mode: "native" for other Vite versions.`
        );
      if (
        !config.build.cssCodeSplit ||
        config.css.transformer === "lightningcss"
      )
        throw new Error(
          "[mincho] dist-chunk requires cssCodeSplit and Vite's PostCSS transformer."
        );
    },

    begin() {
      outputs = new WeakMap();
      chunks = undefined;
      // Keep IR for Rollup's unchanged transform cache in watch mode.
    },

    collect(
      data: InternalVanillaCssArtifact,
      next: Map<string, Artifact>
    ): string {
      const origin = normalizePath(`${data.origin}.vanilla.css`);
      const id = `${prefix}${digest(JSON.stringify([origin, data]))}`;
      next.set(id, { origin, data: structuredClone(data) });

      return `import ${JSON.stringify(id)};`;
    },

    transaction() {
      return new Map<string, Artifact>();
    },

    commit(owner: string, next: ReadonlyMap<string, Artifact>) {
      clearOwner(owner);
      owners.set(owner, new Set(next.keys()));

      for (const [id, artifact] of next) artifacts.set(id, artifact);
    },

    clearOwner,

    clear() {
      artifacts.clear();
      owners.clear();
      chunks = undefined;
    },

    resolve(id: string) {
      if (enabled && artifacts.has(id))
        return { id, moduleSideEffects: "no-treeshake" as const };
    },

    load(id: string) {
      if (!enabled || !id.startsWith(prefix)) return;
      if (!artifacts.has(id))
        throw new Error(`[mincho] Missing dist-chunk style artifact: ${id}`);

      return { code: "export {};", moduleSideEffects: "no-treeshake" as const };
    },

    plan(
      context: Pick<Rollup.PluginContext, "getModuleIds">,
      preview?: (id: string, source: string) => void
    ) {
      if (!enabled) return;

      const live = new Set(context.getModuleIds());
      const selected = [...artifacts].filter(([id]) => live.has(id));
      const cssIds = selected.map(([, artifact]) => artifact.origin);
      const opaque = config.plugins.find(
        (plugin) =>
          plugin.transform &&
          !nativeTransforms.has(plugin.name) &&
          ![
            "mincho-css-vite",
            "mincho:jsx-runtime-provenance",
            "mincho:jsx-runtime-guards"
          ].includes(plugin.name) &&
          !excludesCss(plugin.transform, cssIds)
      );
      if (cssIds.length && opaque)
        throw new Error(
          `[mincho] dist-chunk cannot replay CSS transform ${JSON.stringify(opaque.name)}. Declare a transform.filter.id excluding generated CSS, or use appCss.mode: "native".`
        );
      if (preview)
        for (const [id, artifact] of selected) {
          report("css-ir-preview", { id });
          preview(id, internalGenerateVanillaCss(artifact.data));
        }

      for (const id of artifacts.keys())
        if (!live.has(id)) artifacts.delete(id);

      for (const [owner, ids] of owners) {
        for (const id of ids) if (!live.has(id)) ids.delete(id);

        if (!ids.size) owners.delete(owner);
      }
    },

    async render(
      context: Rollup.PluginContext,
      chunk: Rollup.RenderedChunk,
      output: Rollup.NormalizedOutputOptions,
      allChunks: Record<string, Rollup.RenderedChunk>
    ) {
      if (!enabled) return;
      if (output.format !== "es" && output.format !== "cjs")
        throw new Error(
          "[mincho] dist-chunk supports ES and CJS application output."
        );

      chunks = allChunks;

      let number = outputs.get(output);

      if (number === undefined) {
        number = ++outputNumber;
        outputs.set(output, number);
      }

      const modules: typeof chunk.modules = {};

      for (const [id, module] of Object.entries(chunk.modules)) {
        modules[id] = module;

        if (!id.startsWith(prefix)) continue;

        const artifact = artifacts.get(id);
        if (!artifact)
          throw new Error(`[mincho] Missing dist-chunk style artifact: ${id}`);

        report("css-ir-generate", { chunk: chunk.fileName, id });

        // Keep physical file boundaries for URL resolution, PostCSS, cascade and
        // conditional ordering; ordinary CSS remains in its native position.
        const source = internalGenerateVanillaCss(artifact.data);
        const compiled = await cssTransform!.call(
          context as ThisParameterType<Transform>,
          source,
          artifact.origin
        );

        const css = typeof compiled === "string" ? compiled : compiled?.code;
        if (css === undefined)
          throw new Error(
            "[mincho] Vite CSS adapter did not compile generated CSS."
          );

        const syntheticId = `${artifact.origin}.mincho-${number}-${digest(chunk.fileName + id).slice(0, 16)}.css`;
        await cssPostTransform!.call(
          context as ThisParameterType<Transform>,
          css,
          syntheticId
        );
        modules[syntheticId] = {
          code: null,
          originalLength: 0,
          renderedLength: 0,
          removedExports: [],
          renderedExports: []
        };
      }

      chunk.modules = modules;
    }
  };
}
