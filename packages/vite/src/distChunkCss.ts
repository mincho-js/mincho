import { createHash } from "node:crypto";
import { normalizePath } from "@rollup/pluginutils";
import {
  internalGenerateVanillaCss,
  internalHashVanillaCssArtifact,
  internalOptimizeVanillaCssArtifacts,
  type InternalCompilationCache,
  type InternalCssIrOptimizationOptions,
  type InternalVanillaCssArtifact
} from "@mincho-js/integration";
import { version, type Plugin, type ResolvedConfig, type Rollup } from "vite";
import { excludesCss, nativeTransforms } from "./cssSharing.js";
import { hasOpaquePostcss } from "./cssOptimizationGuard.js";

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
  serializationKey?: string;
}

type Provenance = InternalVanillaCssArtifact["provenance"];

/** Export visibility belongs to evaluations, not the shared CSS identity. */
function mergeProvenance(values: Iterable<Provenance>): Provenance {
  const publicReferences = new Set<string>();
  const generatedVariables = new Set<string>();
  let opaque = false;

  for (const value of values) {
    if (!value || value.version !== 1) {
      opaque = true;
      continue;
    }

    opaque ||= value.opaque;

    for (const name of value.publicReferences) publicReferences.add(name);

    for (const name of value.generatedVariables) generatedVariables.add(name);
  }

  return {
    version: 1,
    publicReferences: [...publicReferences].sort(),
    generatedVariables: [...generatedVariables].sort(),
    opaque
  };
}

const ownerModuleId = (id: string) => normalizePath(id.replace(/[?#].*$/, ""));

const runtimeCssAccess =
  /\b(?:getComputedStyle|computedStyleMap|cssRules|styleSheets|getPropertyValue|setProperty|registerProperty)\b/;

/** One instance per Vite environment. Only output hooks serialize final CSS. */
export function createDistChunkCss(
  report: (phase: string, detail: unknown) => void,
  getCache: () => InternalCompilationCache | undefined = () => undefined
) {
  const artifacts = new Map<string, Artifact>();
  const owners = new Map<string, Set<string>>();
  const provenanceByOwner = new Map<string, Map<string, Provenance>>();
  const optimized = new Map<string, Artifact>();
  let optimization: InternalCssIrOptimizationOptions | undefined;
  let config: ResolvedConfig;
  let enabled = false;
  let cssTransform: Transform | undefined;
  let cssPostTransform: Transform | undefined;
  let outputNumber = 0;
  let outputs = new WeakMap<object, number>();
  let chunks: Record<string, Rollup.RenderedChunk> | undefined;

  async function serialize(id: string, artifact: Artifact) {
    let created = false;

    const create = async () => {
      created = true;

      const start = performance.now();
      const value = internalGenerateVanillaCss(artifact.data);
      const bytes = Buffer.byteLength(value);
      report("css-ir-serialize", {
        id,
        bytes,
        milliseconds: performance.now() - start
      });

      return {
        value,
        bytes,
        owner: artifact.data.origin,
        dependencies: [artifact.data.origin],

        valid: async () => true
      };
    };

    const cache = getCache();

    // IDs include origin, rules, file scope and composition context. Native
    // CSS transforms, URL resolution and asset emission still run every time.
    const value = cache
      ? await cache.run(
          `css-ir-text-ve1.20.1-v2:${artifact.serializationKey ?? id}`,
          create
        )
      : (await create()).value;

    report("css-ir-serialize-cache", { id, hit: !created, enabled: !!cache });

    return value;
  }

  const recomputeProvenance = (id: string) => {
    optimized.delete(id);

    const contributions = provenanceByOwner.get(id);

    if (!contributions?.size) {
      provenanceByOwner.delete(id);
      artifacts.delete(id);

      return;
    }

    const artifact = artifacts.get(id)!;
    artifacts.set(id, {
      ...artifact,
      data: {
        ...artifact.data,
        provenance: mergeProvenance(contributions.values())
      }
    });
  };

  const clearOwner = (owner: string) => {
    const previous = owners.get(owner);
    owners.delete(owner);

    for (const id of previous ?? []) {
      provenanceByOwner.get(id)?.delete(owner);
      recomputeProvenance(id);
    }
  };

  return {
    get enabled() {
      return enabled;
    },

    get chunks() {
      return chunks;
    },

    configure(
      resolved: ResolvedConfig,
      active: boolean,
      options?: InternalCssIrOptimizationOptions
    ) {
      config = resolved;
      optimization = options;
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
      optimized.clear();
      // Keep IR for Rollup's unchanged transform cache in watch mode.
    },

    collect(
      data: InternalVanillaCssArtifact,
      next: Map<string, Artifact>
    ): string {
      const origin = normalizePath(`${data.origin}.vanilla.css`);
      const snapshot = structuredClone(data);
      const id = `${prefix}${internalHashVanillaCssArtifact(snapshot)}`;
      const previous = next.get(id);

      if (previous)
        snapshot.provenance = mergeProvenance([
          previous.data.provenance,
          snapshot.provenance
        ]);

      next.set(id, { origin, data: snapshot });

      return `import ${JSON.stringify(id)};`;
    },

    transaction() {
      return new Map<string, Artifact>();
    },

    commit(owner: string, next: ReadonlyMap<string, Artifact>) {
      clearOwner(owner);
      owners.set(owner, new Set(next.keys()));

      for (const [id, artifact] of next) {
        if (!artifacts.has(id)) artifacts.set(id, artifact);

        const contributions =
          provenanceByOwner.get(id) ?? new Map<string, Provenance>();

        contributions.set(owner, artifact.data.provenance);
        provenanceByOwner.set(id, contributions);
        recomputeProvenance(id);
      }
    },

    clearOwner,

    clear() {
      artifacts.clear();
      optimized.clear();
      owners.clear();
      provenanceByOwner.clear();
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

    async plan(
      context: Pick<Rollup.PluginContext, "getModuleIds"> &
        Partial<Pick<Rollup.PluginContext, "getModuleInfo">>,
      preview?: (id: string, source: string) => void
    ) {
      if (!enabled) return;

      optimized.clear();

      const live = new Set(context.getModuleIds());
      const liveOwners = new Set([...live].map(ownerModuleId));

      // Watch builds retain unchanged owners. A removed consumer must no longer
      // keep shared resources public just because another owner keeps the CSS.
      for (const [owner, ids] of owners) {
        if (!liveOwners.has(ownerModuleId(owner))) {
          clearOwner(owner);
          continue;
        }

        for (const id of ids) {
          if (live.has(id)) continue;

          ids.delete(id);
          provenanceByOwner.get(id)?.delete(owner);
          recomputeProvenance(id);
        }

        if (!ids.size) owners.delete(owner);
      }

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

      if (optimization && selected.length) {
        if (hasOpaquePostcss(config)) {
          report("css-ir-optimize", {
            applied: false,
            reason: "opaque-postcss"
          });
        } else {
          // Runtime CSSOM reads/writes can observe otherwise private resources.
          // A string/key match is intentionally conservative, including aliases.
          const opaqueRuntime = [...live].some((id) =>
            runtimeCssAccess.test(context.getModuleInfo?.(id)?.code ?? "")
          );

          const result = internalOptimizeVanillaCssArtifacts(
            new Map(selected.map(([id, artifact]) => [id, artifact.data])),
            optimization,
            opaqueRuntime ||
              [...live].some((id) =>
                /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)(?:[?#]|$)/.test(
                  id
                )
              )
          );

          for (const [id, data] of result.artifacts) {
            const original = artifacts.get(id)!;
            optimized.set(id, {
              ...original,
              data,
              serializationKey: `${id}:ir-opt-v2:${internalHashVanillaCssArtifact(data)}`
            });
          }

          report("css-ir-optimize", {
            applied: true,
            ...result.diagnostics,
            ...(opaqueRuntime ? { liveness: "opaque-runtime-css" } : {})
          });
        }
      }

      if (preview)
        for (const [id, artifact] of selected) {
          report("css-ir-preview", { id });
          preview(id, await serialize(id, optimized.get(id) ?? artifact));
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

        const artifact = optimized.get(id) ?? artifacts.get(id);
        if (!artifact)
          throw new Error(`[mincho] Missing dist-chunk style artifact: ${id}`);

        report("css-ir-generate", { chunk: chunk.fileName, id });

        // Keep physical file boundaries for URL resolution, PostCSS, cascade and
        // conditional ordering; ordinary CSS remains in its native position.
        const source = await serialize(id, artifact);
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
