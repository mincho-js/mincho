import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { normalizePath } from "@rollup/pluginutils";
import {
  internalGenerateVanillaCss,
  internalAnalyzeCssObservability,
  internalAnalyzeClosedAppUsage,
  internalStaticModuleSpecifiers,
  type ClosedAppUsageOptions,
  internalHashVanillaCssArtifact,
  internalOptimizeVanillaCssArtifacts,
  internalCssVariableLivenessOpaque,
  internalCssResourcesNeedWholeGraph,
  type InternalCompilationCache,
  type InternalCssIrOptimizationOptions,
  type InternalVanillaCssArtifact
} from "@mincho-js/integration";
import { version, type Plugin, type ResolvedConfig, type Rollup } from "vite";
import { excludesCss, nativeTransforms } from "./cssSharing.js";
import { hasOpaquePostcss } from "./cssOptimizationGuard.js";
import { CssIrAggregation } from "./cssIrAggregation.js";

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

type ResourceProof = {
  uses?: readonly { id: string; used: readonly string[] | null }[];
  references?: readonly string[];
};

/** Export visibility belongs to evaluations, not the shared CSS identity. */
function mergeProvenance(values: Iterable<Provenance>): Provenance {
  const contributions = [...values];
  const publicReferences = new Set<string>();
  const generatedVariables = new Set<string>();
  let opaque = false;

  for (const value of contributions) {
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
    opaque,
    ...(contributions.every((value) => value?.resources?.version === 2)
      ? {
          resources: {
            version: 2 as const,
            fonts: [
              ...new Set(
                contributions.flatMap((value) => value!.resources!.fonts ?? [])
              )
            ].sort(),
            publicFonts: [
              ...new Set(
                contributions.flatMap(
                  (value) =>
                    value!.resources!.publicFonts ??
                    value!.resources!.fonts ??
                    []
                )
              )
            ].sort(),
            keyframes: [
              ...new Set(
                contributions.flatMap((value) => value!.resources!.keyframes)
              )
            ].sort(),
            foreignKeyframes: [
              ...new Set(
                contributions.flatMap(
                  (value) => value!.resources!.foreignKeyframes ?? []
                )
              )
            ].sort(),
            publicKeyframes: [
              ...new Set(
                contributions.flatMap((value) => [
                  ...value!.resources!.publicKeyframes
                ])
              )
            ].sort(),
            themes: [...new Set(contributions[0]!.resources!.themes)]
              .filter((name) =>
                contributions.every((value) =>
                  value!.resources!.themes.includes(name)
                )
              )
              .sort(),
            recipes: [
              ...new Set(
                contributions.flatMap((value) =>
                  value!.resources!.recipes.map((recipe) => recipe.id)
                )
              )
            ]
              .sort()
              .map((id) => {
                const entries = contributions.map((value) =>
                  value!.resources!.recipes.find((recipe) => recipe.id === id)
                );

                return {
                  id,

                  // Every contributor must agree that this rule belongs to the recipe.
                  classes: (entries[0]?.classes ?? [])
                    .filter((name) =>
                      entries.every((entry) => entry?.classes.includes(name))
                    )
                    .sort(),
                  references: [
                    ...new Set(
                      entries.flatMap((entry) => entry?.references ?? [])
                    )
                  ].sort()
                };
              }),
            recipeUses: [
              ...new Set(
                contributions.flatMap((value) =>
                  value!.resources!.recipes.map((recipe) => recipe.id)
                )
              )
            ]
              .sort()
              .map((id) => {
                const uses = contributions
                  .filter((value) =>
                    value!.resources!.recipes.some((recipe) => recipe.id === id)
                  )
                  .map(
                    (value) =>
                      value!.resources!.recipeUses?.find((use) => use.id === id)
                        ?.used
                  );

                return {
                  id,
                  used: uses.every((use) => use != null)
                    ? [...new Set(uses.flatMap((use) => [...use!]))].sort()
                    : null
                };
              })
          }
        }
      : {})
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
  const recipeUses = new Map<
    string,
    readonly { id: string; used: readonly string[] | null }[]
  >();

  const privateResourceReferences = new Map<string, readonly string[]>();

  // Original consumer code is inspected only after CSS capture and graph guards.
  // Keep unchanged owners across watch builds; clearOwner releases both inputs.
  const resourceProofs = new Map<
    string,
    (source: string) => Promise<ResourceProof>
  >();

  const resourceSources = new Map<string, string>();
  const fingerprints = new Map<string, string>();
  const dirty = new Set<string>();
  const aggregation = new CssIrAggregation();
  let optimization: InternalCssIrOptimizationOptions | undefined;
  let config: ResolvedConfig;
  let enabled = false;

  let usage: ClosedAppUsageOptions | undefined;
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
    const contributions = provenanceByOwner.get(id);

    if (!contributions?.size) {
      provenanceByOwner.delete(id);
      artifacts.delete(id);
      fingerprints.delete(id);
      optimized.delete(id);
      dirty.add(id);

      return;
    }

    const artifact = artifacts.get(id)!;
    const provenance = mergeProvenance(
      [...contributions].map(([owner, value]) =>
        value?.resources
          ? {
              ...value,
              resources: {
                ...value.resources,
                recipeUses: recipeUses.get(owner),
                publicFonts: value.resources.publicFonts?.filter(
                  (name) =>
                    !privateResourceReferences
                      .get(owner)
                      ?.some(
                        (reference) => reference.replace(/^"|"$/g, "") === name
                      )
                ),
                publicKeyframes: value.resources.publicKeyframes.filter(
                  (name) =>
                    !privateResourceReferences.get(owner)?.includes(name)
                )
              }
            }
          : value
      )
    );

    const fingerprint = digest(JSON.stringify(provenance));
    if (fingerprints.get(id) === fingerprint) return;

    fingerprints.set(id, fingerprint);
    dirty.add(id);
    optimized.delete(id);
    artifacts.set(id, {
      ...artifact,
      data: {
        ...artifact.data,
        provenance
      }
    });
  };

  const clearOwner = (owner: string) => {
    const previous = owners.get(owner);
    owners.delete(owner);
    recipeUses.delete(owner);
    privateResourceReferences.delete(owner);
    resourceProofs.delete(owner);
    resourceSources.delete(owner);

    for (const id of previous ?? []) {
      provenanceByOwner.get(id)?.delete(owner);
      recomputeProvenance(id);
    }
  };

  const recordRecipeUses = (
    owner: string,
    uses: NonNullable<ResourceProof["uses"]> = [],
    references: readonly string[] = []
  ) => {
    if (
      !enabled ||
      (!optimization?.pruneRecipes && !optimization?.pruneKeyframes)
    )
      return;
    if (
      JSON.stringify([
        recipeUses.get(owner),
        privateResourceReferences.get(owner)
      ]) === JSON.stringify([uses, references])
    )
      return;

    recipeUses.set(owner, uses);
    privateResourceReferences.set(owner, references);

    for (const id of owners.get(owner) ?? []) recomputeProvenance(id);
  };

  return {
    setUsage(value: ClosedAppUsageOptions | undefined) {
      usage = value;
    },
    get enabled() {
      return enabled;
    },

    get needsResourceProofs() {
      return (
        enabled &&
        (optimization?.pruneRecipes === true ||
          optimization?.pruneKeyframes === true)
      );
    },

    recordRecipeUses,

    recordResourceProof(
      owner: string,
      analyze: (source: string) => Promise<ResourceProof>
    ) {
      resourceProofs.set(owner, analyze);
      recordRecipeUses(owner);
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

    commit(
      owner: string,
      next: ReadonlyMap<string, Artifact>,
      source?: string
    ) {
      if (
        source !== undefined &&
        (optimization?.pruneRecipes || optimization?.pruneKeyframes)
      )
        resourceSources.set(owner, source);

      // Retain immutable IR/facts for unchanged contributions instead of delete/re-add.
      for (const id of owners.get(owner) ?? [])
        if (!next.has(id)) {
          provenanceByOwner.get(id)?.delete(owner);
          recomputeProvenance(id);
        }

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
      recipeUses.clear();
      privateResourceReferences.clear();
      resourceProofs.clear();
      resourceSources.clear();
      fingerprints.clear();
      dirty.clear();
      aggregation.clear();
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
        Partial<Pick<Rollup.PluginContext, "getModuleInfo" | "resolve">>,
      preview?: (id: string, source: string) => void
    ) {
      if (!enabled) return;

      optimized.clear();

      const live = new Set(context.getModuleIds());
      const liveOwners = new Set([...live].map(ownerModuleId));

      for (const owner of resourceProofs.keys())
        if (!liveOwners.has(ownerModuleId(owner))) clearOwner(owner);

      for (const owner of recipeUses.keys())
        if (!liveOwners.has(ownerModuleId(owner))) {
          recipeUses.delete(owner);
          privateResourceReferences.delete(owner);
        }

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

      let selected = [...artifacts].filter(([id]) => live.has(id));
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
          const observations = optimization.scopedResourceAnalysis
            ? [...live]
                .filter(
                  (id) =>
                    !id.startsWith(prefix) &&
                    !/\.(?:css|scss|sass|less)(?:[?#]|$)/.test(id)
                )
                .map((id) => {
                  const info = context.getModuleInfo?.(id);
                  return !info ||
                    info.isExternal ||
                    typeof info.code !== "string"
                    ? {
                        whole: true,
                        variables: [],
                        names: [],
                        reasons: ["unknown-runtime-source"]
                      }
                    : internalAnalyzeCssObservability(info.code);
                })
            : [];
          const opaqueRuntime = optimization.scopedResourceAnalysis
            ? observations.some((item) => item.whole)
            : [...live].some((id) =>
                runtimeCssAccess.test(context.getModuleInfo?.(id)?.code ?? "")
              );
          const observedVariables = [
            ...new Set(observations.flatMap((item) => item.variables))
          ];

          const observedNames = [
            ...new Set(observations.flatMap((item) => item.names))
          ];
          if (optimization.scopedResourceAnalysis)
            report("css-observability", {
              whole: opaqueRuntime,
              variables: observedVariables,
              names: observedNames,
              reasons: [
                ...new Set(observations.flatMap((item) => item.reasons))
              ]
            });

          const external =
            opaqueRuntime ||
            [...live].some((id) =>
              /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)(?:[?#]|$)/.test(
                id
              )
            );

          const resourceBarrier = selected.some(
            ([, { data }]) =>
              !data.provenance ||
              data.provenance.opaque ||
              data.provenance.resources?.version !== 2
          );

          const candidates = { recipes: 0, keyframes: 0 };

          for (const [, { data }] of selected) {
            candidates.recipes +=
              data.provenance?.resources?.recipes.length ?? 0;
            candidates.keyframes +=
              data.provenance?.resources?.keyframes.length ?? 0;
          }

          const resourceSettings = {
            pruneRecipes:
              !!optimization.pruneRecipes &&
              !external &&
              !resourceBarrier &&
              candidates.recipes > 0,
            pruneKeyframes:
              !!optimization.pruneKeyframes &&
              !external &&
              !resourceBarrier &&
              candidates.keyframes > 0
          };

          let analyzedOwners = 0;

          if (
            resourceSettings.pruneRecipes ||
            resourceSettings.pruneKeyframes
          ) {
            for (const [owner, analyze] of resourceProofs) {
              const relevant = [...(owners.get(owner) ?? [])].some((id) => {
                const resources = provenanceByOwner
                  .get(id)
                  ?.get(owner)?.resources;

                return (
                  (resourceSettings.pruneRecipes &&
                    !!resources?.recipes.length) ||
                  (resourceSettings.pruneKeyframes &&
                    !!resources?.keyframes.length)
                );
              });

              const source = resourceSources.get(owner);
              if (!relevant || source === undefined) continue;

              const proof = await analyze(source);
              recordRecipeUses(owner, proof.uses, proof.references);
              analyzedOwners++;
            }

            // Proof changes visibility, never CSS identity or module membership.
            selected = selected.map(([id]) => [id, artifacts.get(id)!]);
          }

          if (optimization.pruneRecipes || optimization.pruneKeyframes)
            report("css-resource-proofs", {
              candidates,
              analyzedOwners,
              reason: external
                ? "external-css"
                : resourceBarrier
                  ? "missing-or-opaque-provenance"
                  : resourceSettings.pruneRecipes ||
                      resourceSettings.pruneKeyframes
                    ? "eligible"
                    : "no-candidates"
            });

          let closedUsage:
            | ReturnType<typeof internalAnalyzeClosedAppUsage>
            | undefined;
          if (usage) {
            const modules = [];
            for (const id of live) {
              const info = context.getModuleInfo?.(id);
              if (
                !info?.code ||
                id.startsWith(prefix) ||
                /\.(?:css|scss|sass|less)(?:[?#]|$)/.test(id)
              )
                continue;
              const imports = new Map<string, string>();
              let unresolved = false;
              for (const source of [
                ...info.importedIdResolutions,
                ...info.dynamicallyImportedIdResolutions
              ])
                if (!source.external) imports.set(source.id, source.id);
              for (const source of internalStaticModuleSpecifiers(info.code)) {
                if (imports.has(source)) continue;
                const resolved = await context.resolve?.(source, id, {
                  skipSelf: false
                });
                if (resolved && !resolved.external)
                  imports.set(source, resolved.id);
                if (!resolved) unresolved = true;
              }
              modules.push({
                id,
                code: info.code,
                imports,
                unresolved,
                entry: info.isEntry
              });
            }
            const preserve = usage.preserve?.map((item) => ({
              ...item,
              module: normalizePath(resolve(config.root, item.module))
            }));
            for (const item of preserve ?? [])
              if (!modules.some((module) => module.id === item.module))
                throw new Error(
                  `appCss.usage.preserve refers to a module absent from the graph: ${item.module}`
                );
            closedUsage = internalAnalyzeClosedAppUsage(modules, {
              ...usage,
              preserve
            });
            report("closed-app-usage", {
              opaque: closedUsage.opaque,
              reason: closedUsage.reason,
              recipes: closedUsage.recipes
            });
          }
          const input = new Map(
            selected.map(([id, artifact]) => {
              const data = artifact.data;
              if (!data.provenance) return [id, data] as const;
              const closed =
                closedUsage && !closedUsage.opaque ? closedUsage : undefined;
              return [
                id,
                {
                  ...data,
                  provenance: {
                    ...data.provenance,
                    publicReferences: [
                      ...new Set([
                        ...data.provenance.publicReferences.filter(
                          (name) =>
                            !closed || closed.variableReferences.includes(name)
                        ),
                        ...observedVariables
                      ])
                    ],
                    resources: data.provenance.resources && {
                      ...data.provenance.resources,
                      publicKeyframes: [
                        ...new Set([
                          ...data.provenance.resources.publicKeyframes,
                          ...observedNames
                        ])
                      ],
                      publicFonts: [
                        ...new Set([
                          ...(data.provenance.resources.publicFonts ?? []),
                          ...observedNames
                        ])
                      ],
                      recipeUses: data.provenance.resources.recipes
                        .map(
                          (recipe) =>
                            closed?.recipes.find(
                              (use) => use.id === recipe.id
                            ) ??
                            data.provenance!.resources!.recipeUses?.find(
                              (use) => use.id === recipe.id
                            ) ?? { id: recipe.id, used: null }
                        )
                        .map((use) =>
                          observedNames.some((name) =>
                            data
                              .provenance!.resources!.recipes.find(
                                (recipe) => recipe.id === use.id
                              )
                              ?.references.includes(name)
                          )
                            ? { ...use, used: null }
                            : use
                        )
                    }
                  }
                }
              ] as const;
            })
          );

          const componentPasses =
            resourceSettings.pruneRecipes ||
            resourceSettings.pruneKeyframes ||
            optimization.mergeConditionalRules ||
            optimization.internThemeValues;

          const topology = aggregation.update(input);
          const groups =
            optimization.internThemeValues ||
            [...input.values()].some(internalCssResourcesNeedWholeGraph)
              ? [[...input.keys()].sort()]
              : topology;

          // Legacy opaque-variable semantics remain global, even for independent groups.
          const variableBarrier = [...input.values()].some((data) =>
            internalCssVariableLivenessOpaque(
              data,
              resourceSettings.pruneKeyframes
            )
          );

          const settings = {
            ...optimization,
            ...resourceSettings,
            ...(componentPasses && variableBarrier
              ? { pruneGenerated: false }
              : {})
          };

          let reanalyzedOwners = 0;
          let cacheHits = 0;

          for (const ids of componentPasses
            ? groups
            : [[...input.keys()].sort()]) {
            const key = `css-ir-opt-resources-v6-ve1.20.1:${digest(
              JSON.stringify([
                ids.map((id) => [id, fingerprints.get(id)]),
                settings,
                observedVariables,
                observedNames,
                closedUsage,
                external,
                variableBarrier,
                resourceBarrier
              ])
            )}`;

            let created = false;

            const create = async () => {
              created = true;

              const result = internalOptimizeVanillaCssArtifacts(
                new Map(ids.map((id) => [id, input.get(id)!])),
                settings,
                external
              );

              const value = {
                artifacts: [...result.artifacts].map(([id, data]) => ({
                  id,
                  data,
                  serializationKey: `${id}:ir-opt-v3:${internalHashVanillaCssArtifact(data)}`
                })),
                diagnostics: result.diagnostics
              };

              return {
                value,
                bytes: Buffer.byteLength(JSON.stringify(value)),
                dependencies: [],

                valid: async () => true
              };
            };

            const cache = getCache();
            const result = cache
              ? await cache.run(key, create)
              : (await create()).value;

            if (created) reanalyzedOwners += ids.length;
            else cacheHits += ids.length;

            for (const { id, data, serializationKey } of result.artifacts)
              optimized.set(id, {
                ...artifacts.get(id)!,
                data,
                serializationKey
              });

            report("css-ir-optimize", {
              applied: true,
              ...result.diagnostics,
              ...(componentPasses && variableBarrier
                ? { liveness: "opaque-resource-references" }
                : {}),
              ...(resourceBarrier
                ? { resourceBailout: "missing-or-opaque-provenance" }
                : {}),
              ...(opaqueRuntime ? { liveness: "opaque-runtime-css" } : {})
            });
          }

          report("css-ir-aggregation", {
            dirtyOwners: dirty.size,
            reanalyzedOwners,
            cacheHits,
            components: groups.length,
            cacheEnabled: !!getCache()
          });
        }
      }

      dirty.clear();

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
