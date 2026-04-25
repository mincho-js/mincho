import { addFunctionSerializer } from "@vanilla-extract/css/functionSerializer";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import {
  beginDefineRulesRegistrySession,
  endDefineRulesRegistrySession,
  getActiveDefineRulesRegistrySession
} from "./registry.js";
import type { Serializable } from "../rules/types.js";
import { identifierName } from "../utils.js";
import { createDefineRulesRuntime } from "./runtime.js";
import type { DefineRulesRuntimeResult } from "./runtime.js";
import type {
  DefineRulesCtx,
  DefineRulesPresetArtifactV3,
  DefineRulesPresetInput,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./types.js";

const DEFINE_RULES_SERIALIZED_CSS_FUNCTION_CONFIG_DIAGNOSTIC =
  "defineRules serialized css does not support function-valued properties or shortcuts";
const DEFINE_RULES_RUNTIME_IMPORT_PATH =
  "@mincho-js/css/defineRules/createDefineRulesCssRuntime";
const DEFINE_RULES_RUNTIME_IMPORT_NAME = "createDefineRulesCssRuntime";

// == Define Rules =============================================================
export function defineRules<
  const Properties extends DefineRulesProperties,
  const Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  config: DefineRulesCtx<Properties, Shortcuts>
): DefineRulesRuntimeResult<Properties, Shortcuts> {
  const functionValuedConfigPath =
    getFunctionValuedDefineRulesConfigPath(config);
  const result: DefineRulesRuntimeResult<Properties, Shortcuts> =
    createDefineRulesRuntime<Properties, Shortcuts>(config, {
      registerPreset: functionValuedConfigPath == null
    });
  const serializedConfig = { ...config, presets: result.preset };

  return {
    ...result,
    css: addFunctionSerializer(
      result.css,
      createDefineRulesSerializerRecipe(
        serializedConfig as Serializable,
        functionValuedConfigPath
      )
    ) as DefineRulesRuntimeResult<Properties, Shortcuts>["css"]
  };
}

function createDefineRulesSerializerRecipe(
  serializedConfig: Serializable,
  functionValuedConfigPath: string | undefined
): Parameters<typeof addFunctionSerializer>[1] {
  if (functionValuedConfigPath != null) {
    return {
      importPath: DEFINE_RULES_RUNTIME_IMPORT_PATH,
      importName: DEFINE_RULES_RUNTIME_IMPORT_NAME,
      get args(): ReadonlyArray<Serializable> {
        throw new Error(
          createFunctionValuedConfigDiagnostic(functionValuedConfigPath)
        );
      }
    };
  }

  return {
    importPath: DEFINE_RULES_RUNTIME_IMPORT_PATH,
    importName: DEFINE_RULES_RUNTIME_IMPORT_NAME,
    args: [serializedConfig]
  };
}

function createFunctionValuedConfigDiagnostic(configPath: string): string {
  return `${DEFINE_RULES_SERIALIZED_CSS_FUNCTION_CONFIG_DIAGNOSTIC} at ${configPath}`;
}

function getFunctionValuedDefineRulesConfigPath(config: {
  properties?: object;
  shortcuts?: object;
}): string | undefined {
  return (
    getFunctionValuedEntriesPath(config.properties, "config.properties") ??
    getFunctionValuedEntriesPath(config.shortcuts, "config.shortcuts")
  );
}

function getFunctionValuedEntriesPath(
  entries: object | undefined,
  path: string
): string | undefined {
  if (entries == null) {
    return undefined;
  }

  for (const [key, entry] of Object.entries(entries)) {
    if (typeof entry === "function") {
      return `${path}.${key}`;
    }
  }

  return undefined;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect, afterEach, assertType } = import.meta.vitest;

  const debugId = "myCSS";
  setFileScope("test");

  afterEach(() => {
    while (getActiveDefineRulesRegistrySession() != null) {
      endDefineRulesRegistrySession();
    }
  });

  const createDefineRulesAuthoringShapeOwner = (debugId: string) =>
    defineRules({
      debugId,
      properties: {
        color: true,
        display: ["none", "flex"]
      }
    });

  type DefineRulesAuthoringShapeOwner = ReturnType<
    typeof createDefineRulesAuthoringShapeOwner
  >;
  type DefineRulesAuthoringShapeInput = Parameters<
    DefineRulesAuthoringShapeOwner["css"]
  >[0];

  function expectDefineRulesAuthoringShapeBindings(
    bindings: Pick<DefineRulesAuthoringShapeOwner, "css" | "preset">
  ) {
    assertType<DefineRulesAuthoringShapeOwner["css"]>(bindings.css);
    assertType<DefineRulesPresetArtifactV3>(bindings.preset);
    assertType<DefineRulesAuthoringShapeInput>({
      color: "rebeccapurple",
      display: "flex"
    });

    expect(bindings.preset).toEqual({
      schema: "mincho.defineRulesPreset",
      version: 3,
      classNameByCache: {}
    });
    expect(bindings.css.raw({ display: "flex" })).toEqual({
      display: "flex"
    });

    const className = bindings.css({ display: "flex" });

    expect(Object.values(bindings.preset.classNameByCache)).toEqual([
      className
    ]);
  }

  describe("defineRules", () => {
    describe.concurrent("DefineRules authoring/export shape matrix", () => {
      it("1. owner-object form: export const presetOwner = defineRules({...})", () => {
        const presetOwner =
          createDefineRulesAuthoringShapeOwner("ownerObjectShape");

        assertType<DefineRulesAuthoringShapeOwner>(presetOwner);
        expectDefineRulesAuthoringShapeBindings(presetOwner);
      });

      it("2. direct destructuring form: export const { css, preset } = defineRules({...})", () => {
        const { css, preset } = createDefineRulesAuthoringShapeOwner(
          "directDestructuringShape"
        );

        assertType<DefineRulesAuthoringShapeOwner["css"]>(css);
        assertType<DefineRulesPresetArtifactV3>(preset);
        expectDefineRulesAuthoringShapeBindings({ css, preset });
      });

      it("3. aliased destructuring form: export const { css: sharedCss, preset: sharedPreset } = defineRules({...})", () => {
        const { css: sharedCss, preset: sharedPreset } =
          createDefineRulesAuthoringShapeOwner("aliasedDestructuringShape");

        assertType<DefineRulesAuthoringShapeOwner["css"]>(sharedCss);
        assertType<DefineRulesPresetArtifactV3>(sharedPreset);
        expectDefineRulesAuthoringShapeBindings({
          css: sharedCss,
          preset: sharedPreset
        });
      });

      it("4. owner-object member exports form: const presetOwner = defineRules({...}); export const css = presetOwner.css; export const preset = presetOwner.preset;", () => {
        const presetOwner = createDefineRulesAuthoringShapeOwner(
          "ownerMemberExportsShape"
        );
        const css = presetOwner.css;
        const preset = presetOwner.preset;

        assertType<DefineRulesAuthoringShapeOwner["css"]>(css);
        assertType<DefineRulesPresetArtifactV3>(preset);
        expect(preset).toBe(presetOwner.preset);
        expectDefineRulesAuthoringShapeBindings({ css, preset });
      });

      it("5. exported owner-object destructuring form: export const presetOwner = defineRules({...}); export const { css, preset } = presetOwner;", () => {
        const presetOwner = createDefineRulesAuthoringShapeOwner(
          "exportedOwnerDestructuringShape"
        );
        const { css, preset } = presetOwner;

        assertType<DefineRulesAuthoringShapeOwner["css"]>(css);
        assertType<DefineRulesPresetArtifactV3>(preset);
        expect(preset).toBe(presetOwner.preset);
        expectDefineRulesAuthoringShapeBindings({ css, preset });
      });

      it("6. local destructuring export-list form: const { css, preset } = defineRules({...}); export { css, preset };", () => {
        const { css, preset } = createDefineRulesAuthoringShapeOwner(
          "localDestructuringExportListShape"
        );

        assertType<DefineRulesAuthoringShapeOwner["css"]>(css);
        assertType<DefineRulesPresetArtifactV3>(preset);
        expectDefineRulesAuthoringShapeBindings({ css, preset });
      });

      it("7. public defineRules signature accepts only config", () => {
        const assertRemovedPrivateArgument = () => {
          // @ts-expect-error defineRules only accepts a single config argument.
          defineRules({ properties: { color: true } }, "anything");
        };

        expect(assertRemovedPrivateArgument).toEqual(expect.any(Function));
      });
    });

    describe("DefineRules Registry", () => {
      it("registers live v3 preset artifacts with deferred snapshots", () => {
        const session = beginDefineRulesRegistrySession();

        try {
          const provider = defineRules({
            debugId: "provider",
            properties: {
              color: true
            }
          });

          const middle = defineRules({
            debugId: "ignored",
            properties: {
              color: true
            }
          });

          const consumer = defineRules({
            debugId: "consumer",
            properties: {
              background: true
            }
          });

          const providerColor = provider.css({ color: "red" });
          const middleColor = middle.css({ color: "blue" });
          const consumerBackground = consumer.css({ background: "blue" });

          expect(
            session.instances.map((instance) => instance.registrationId)
          ).toEqual([
            "<root>:test#defineRules:0",
            "<root>:test#defineRules:1",
            "<root>:test#defineRules:2"
          ]);
          expect(
            session.instances.map((instance) => instance.registrationIndex)
          ).toEqual([0, 1, 2]);
          expect(session.instances[0]?.presetArtifact).toBe(provider.preset);
          expect(session.instances[1]?.presetArtifact).toBe(middle.preset);
          expect(session.instances[2]?.presetArtifact).toBe(consumer.preset);
          expect(session.instances[0]?.getPresetSnapshot()).toEqual(
            provider.preset.classNameByCache
          );
          expect(session.instances[1]?.getPresetSnapshot()).toEqual(
            middle.preset.classNameByCache
          );
          expect(session.instances[2]?.getPresetSnapshot()).toEqual(
            consumer.preset.classNameByCache
          );
          expect(Object.values(provider.preset.classNameByCache)).toEqual([
            providerColor
          ]);
          expect(Object.values(middle.preset.classNameByCache)).toEqual([
            middleColor
          ]);
          expect(Object.values(consumer.preset.classNameByCache)).toEqual([
            consumerBackground
          ]);
        } finally {
          expect(endDefineRulesRegistrySession()).toBe(session);
        }

        expect(getActiveDefineRulesRegistrySession()).toBe(undefined);
      });

      it("does not register function-valued configs into registry sessions", () => {
        type DefineRulesRecipe = {
          args?: unknown[];
        };
        const session = beginDefineRulesRegistrySession();

        try {
          const { css } = defineRules({
            debugId: "functionConfigNotRegistered",
            properties: {
              color(value: string) {
                return value;
              }
            }
          });
          const recipe = (
            css as unknown as {
              __recipe__?: DefineRulesRecipe;
            }
          ).__recipe__;

          expect(css.raw({ color: "red" })).toEqual({
            color: "red"
          });
          expect(() => recipe?.args).toThrow(
            DEFINE_RULES_SERIALIZED_CSS_FUNCTION_CONFIG_DIAGNOSTIC
          );
          expect(session.instances).toEqual([]);
        } finally {
          expect(endDefineRulesRegistrySession()).toBe(session);
        }

        expect(getActiveDefineRulesRegistrySession()).toBe(undefined);
      });
    });

    describe.concurrent("DefineRules Presets", () => {
      it("exposes a live preset object through the serializer recipe", () => {
        type DefineRulesRecipe = {
          args?: unknown[];
        };

        type DefineRulesRecipeConfig = {
          presets?: unknown;
        };

        const { css, preset } = defineRules({
          debugId: "serializerPresetIdentity",
          properties: {
            background: true
          }
        });

        const recipe = (
          css as unknown as {
            __recipe__?: DefineRulesRecipe;
          }
        ).__recipe__;
        const recipeConfig = recipe?.args?.[0];

        expect(recipeConfig).toEqual(expect.any(Object));
        expect((recipeConfig as DefineRulesRecipeConfig).presets).toBe(preset);

        const className = css({ background: "blue" });
        const repeatedClassName = css({ background: "blue" });

        expect(
          Object.keys(preset.classNameByCache).every(
            (key) => key.startsWith("fragment_") === false
          )
        ).toBe(true);
        expect(repeatedClassName).toBe(className);
        expect(Object.values(preset.classNameByCache)).toContain(className);
        expect(
          Object.values(preset.classNameByCache).filter(
            (entry) => entry === className
          )
        ).toHaveLength(1);
      });

      it("serializes an empty preset object without static calls", () => {
        type DefineRulesRecipe = {
          args?: unknown[];
        };

        const { css, preset } = defineRules({
          debugId: "emptySerializerPresetIdentity",
          properties: {
            background: true
          }
        });

        const recipe = (
          css as unknown as {
            __recipe__?: DefineRulesRecipe;
          }
        ).__recipe__;
        const recipeConfig = recipe?.args?.[0];

        expect(recipeConfig).toEqual(expect.any(Object));
        expect((recipeConfig as { presets?: unknown }).presets).toBe(preset);
        expect(Object.keys(preset.classNameByCache)).toHaveLength(0);
      });

      it("keeps serialized runtime preset handles live for later static css calls", async () => {
        const { createDefineRulesCssRuntime } =
          await import("./createDefineRulesCssRuntime.js");
        const preset: DefineRulesPresetArtifactV3 = {
          schema: "mincho.defineRulesPreset",
          version: 3,
          classNameByCache: {}
        };
        const css = createDefineRulesCssRuntime({
          debugId: "serializedRuntimePresetHandle",
          properties: {
            background: true
          },
          presets: preset
        });

        const className = css({ background: "blue" });

        expect(Object.values(preset.classNameByCache)).toEqual([className]);
        expect(css({ background: "blue" })).toBe(className);
      });

      it("defineRules serializer rejects function-valued config with diagnostic", () => {
        type DefineRulesRecipe = {
          args?: unknown[];
        };

        const createRecipeArgsReader = (config: unknown) => {
          const { css } = defineRules(config as never);
          const recipe = (
            css as unknown as {
              __recipe__?: DefineRulesRecipe;
            }
          ).__recipe__;

          return () => recipe?.args;
        };

        expect(
          createRecipeArgsReader({
            properties: {
              color(value: string) {
                return value;
              }
            }
          })
        ).toThrow(DEFINE_RULES_SERIALIZED_CSS_FUNCTION_CONFIG_DIAGNOSTIC);
        expect(
          createRecipeArgsReader({
            properties: {
              color: true
            },
            shortcuts: {
              tone(value: "red" | "blue") {
                return {
                  color: value
                } as const;
              }
            }
          })
        ).toThrow(DEFINE_RULES_SERIALIZED_CSS_FUNCTION_CONFIG_DIAGNOSTIC);
      });

      it("Keeps preset handles live for transitive raw record composition", () => {
        const provider = defineRules({
          debugId: "provider",
          properties: {
            color: true
          }
        });
        const providerColor = provider.css({ color: "red" });

        const composed = defineRules({
          debugId: "composed",
          presets: {
            ...provider.preset.classNameByCache
          },
          properties: {
            color: true,
            background: true
          }
        });
        const composedBackground = composed.css({ background: "blue" });

        const transitive = defineRules({
          debugId: "transitive",
          presets: {
            ...composed.preset.classNameByCache
          },
          properties: {
            color: true,
            background: true,
            display: true
          }
        });
        const transitiveDisplay = transitive.css({ display: "block" });

        expect(Object.values(provider.preset.classNameByCache)).toEqual([
          providerColor
        ]);
        expect(Object.values(composed.preset.classNameByCache)).toEqual(
          expect.arrayContaining([providerColor, composedBackground])
        );
        expect(Object.values(composed.preset.classNameByCache)).toHaveLength(2);
        expect(Object.values(transitive.preset.classNameByCache)).toEqual(
          expect.arrayContaining([
            providerColor,
            composedBackground,
            transitiveDisplay
          ])
        );
        expect(Object.values(transitive.preset.classNameByCache)).toHaveLength(
          3
        );
        expect(composed.preset).not.toBe(provider.preset);
        expect(transitive.preset).not.toBe(composed.preset);
      });

      it("Imports v3 preset artifacts by copying classNameByCache", () => {
        const provider = defineRules({
          debugId: "v3Provider",
          properties: {
            color: true
          }
        });
        const providerColor = provider.css({ color: "red" });
        const artifact: DefineRulesPresetArtifactV3 = {
          schema: "mincho.defineRulesPreset",
          version: 3,
          classNameByCache: {
            ...provider.preset.classNameByCache
          }
        };
        const artifactSnapshot = {
          ...artifact.classNameByCache
        };

        const consumer = defineRules({
          debugId: "v3Consumer",
          presets: artifact,
          properties: {
            color: true,
            background: true
          }
        });

        expect(consumer.preset.classNameByCache).toEqual(artifactSnapshot);
        expect(consumer.preset.classNameByCache).not.toBe(
          artifact.classNameByCache
        );
        expect(consumer.css({ color: "red" })).toBe(providerColor);

        const consumerBackground = consumer.css({ background: "blue" });

        expect(Object.values(consumer.preset.classNameByCache)).toEqual(
          expect.arrayContaining([providerColor, consumerBackground])
        );
        expect(Object.values(consumer.preset.classNameByCache)).toHaveLength(2);
        expect(artifact.classNameByCache).toEqual(artifactSnapshot);
      });

      it("Merges recursive preset input arrays without mutating imports", () => {
        const colorProvider = defineRules({
          debugId: "arrayColorProvider",
          properties: {
            color: true
          }
        });
        const displayProvider = defineRules({
          debugId: "arrayDisplayProvider",
          properties: {
            display: true
          }
        });
        const colorClassName = colorProvider.css({ color: "red" });
        const displayClassName = displayProvider.css({ display: "flex" });
        const displayArtifact: DefineRulesPresetArtifactV3 = {
          schema: "mincho.defineRulesPreset",
          version: 3,
          classNameByCache: {
            ...displayProvider.preset.classNameByCache
          }
        };
        const displayArtifactSnapshot = {
          ...displayArtifact.classNameByCache
        };

        const consumer = defineRules({
          debugId: "arrayConsumer",
          presets: [colorProvider.preset, [displayArtifact]],
          properties: {
            color: true,
            display: true,
            background: true
          }
        });

        expect(consumer.css({ color: "red" })).toBe(colorClassName);
        expect(consumer.css({ display: "flex" })).toBe(displayClassName);

        const consumerBackground = consumer.css({ background: "blue" });

        expect(Object.values(consumer.preset.classNameByCache)).toEqual(
          expect.arrayContaining([
            colorClassName,
            displayClassName,
            consumerBackground
          ])
        );
        expect(Object.values(consumer.preset.classNameByCache)).toHaveLength(3);
        expect(Object.values(colorProvider.preset.classNameByCache)).toEqual([
          colorClassName
        ]);
        expect(displayArtifact.classNameByCache).toEqual(
          displayArtifactSnapshot
        );
      });

      it("Rejects malformed preset input", () => {
        const createMalformedPresetCase = (presets: unknown) => () =>
          defineRules({
            presets: presets as DefineRulesPresetInput,
            properties: {
              color: true
            }
          });

        const ownerPresetInput: unknown = {
          css: true,
          preset: {
            colorRed: "color_red"
          }
        };
        const legacyPresetCacheKey = ["className", "ByCache"].join("");
        const legacySerializedPresetEnvelope: unknown = {
          schema: "mincho.defineRulesPreset",
          version: Number("2"),
          [legacyPresetCacheKey]: {
            colorRed: "color_red"
          }
        };
        const invalidArtifact: unknown = {
          schema: "mincho.defineRulesPreset",
          version: 3,
          classNameByCache: {
            colorRed: 1
          }
        };

        expect(createMalformedPresetCase(ownerPresetInput)).toThrow(
          "Unsupported defineRules preset input at config.presets"
        );

        expect(
          createMalformedPresetCase(legacySerializedPresetEnvelope)
        ).toThrow("Unsupported defineRules preset input at config.presets");

        expect(createMalformedPresetCase(new Map())).toThrow(
          "Unsupported defineRules preset input at config.presets"
        );

        expect(createMalformedPresetCase(invalidArtifact)).toThrow(
          "Unsupported defineRules preset input at " +
            "config.presets.classNameByCache"
        );

        expect(
          createMalformedPresetCase([
            { colorRed: "color_red" },
            ownerPresetInput
          ])
        ).toThrow("Unsupported defineRules preset input at config.presets[1]");
      });

      it("Reuses seeded preset class names without overwriting imported entries", () => {
        const provider = defineRules({
          debugId: "provider",
          properties: {
            background: true
          }
        });
        const providerBackground = provider.css({ background: "blue" });
        const importedPreset = {
          ...provider.preset.classNameByCache
        };

        const consumer = defineRules({
          debugId: "consumer",
          presets: importedPreset,
          properties: {
            background: true
          }
        });
        const presetHandle = consumer.preset.classNameByCache;

        expect(presetHandle).toEqual(importedPreset);

        const reusedBackground = consumer.css({ background: "blue" });

        expect(reusedBackground).toBe(providerBackground);
        expect(reusedBackground).not.toMatch(identifierName("consumer"));
        expect(presetHandle).toEqual(importedPreset);
        expect(Object.values(presetHandle)).toEqual([providerBackground]);
        expect(
          Object.values(presetHandle).filter(
            (className) => className === reusedBackground
          )
        ).toHaveLength(1);
        expect(presetHandle).toBe(consumer.preset.classNameByCache);
        expect(importedPreset).toEqual(provider.preset.classNameByCache);
      });

      it("Keeps seeded preset handles isolated across defineRules instances", () => {
        const provider = defineRules({
          debugId: "provider",
          properties: {
            color: true
          }
        });
        const providerColor = provider.css({ color: "red" });
        const sharedPreset = {
          ...provider.preset.classNameByCache
        };

        const consumerA = defineRules({
          debugId: "consumerA",
          presets: sharedPreset,
          properties: {
            color: true,
            background: true
          }
        });
        const consumerB = defineRules({
          debugId: "consumerB",
          presets: sharedPreset,
          properties: {
            color: true,
            background: true
          }
        });

        expect(consumerA.css({ color: "red" })).toBe(providerColor);
        expect(consumerB.css({ color: "red" })).toBe(providerColor);

        const consumerABackground = consumerA.css({ background: "blue" });

        expect(Object.values(consumerA.preset.classNameByCache)).toEqual(
          expect.arrayContaining([providerColor, consumerABackground])
        );
        expect(Object.values(consumerA.preset.classNameByCache)).toHaveLength(
          2
        );
        expect(Object.values(consumerB.preset.classNameByCache)).toEqual([
          providerColor
        ]);

        const consumerBBackground = consumerB.css({ background: "blue" });

        expect(consumerABackground).not.toBe(consumerBBackground);
        expect(Object.values(consumerB.preset.classNameByCache)).toEqual(
          expect.arrayContaining([providerColor, consumerBBackground])
        );
        expect(Object.values(consumerB.preset.classNameByCache)).not.toContain(
          consumerABackground
        );
        expect(sharedPreset).toEqual(provider.preset.classNameByCache);
      });
    });

    describe.concurrent("DefineRules Properties", () => {
      it("Array values for CSS properties", () => {
        const { css } = defineRules({
          properties: {
            display: ["none", "inline", "block"],
            paddingLeft: [0, 2, 4, 8, 16, 32, 64]
          }
        });

        expect(
          css.raw({
            display: "inline",
            paddingLeft: 4
          })
        ).toEqual({
          display: "inline",
          paddingLeft: 4
        });
      });

      it("Object values for CSS properties", () => {
        const { css } = defineRules({
          properties: {
            color: {
              "indigo-800": "rgb(55, 48, 163)",
              "red-500": "rgb(239, 68, 68)"
            }
          }
        });

        expect(
          css.raw({
            color: "indigo-800"
          })
        ).toEqual({
          color: "rgb(55, 48, 163)"
        });
      });

      it("Object values with CSSPropertiesWithVars", () => {
        const alpha = "--alpha";
        const { css } = defineRules({
          properties: {
            background: {
              red: {
                vars: { [alpha]: "1" },
                background: `rgba(255, 0, 0, var(${alpha}))`
              }
            }
          }
        });

        expect(
          css.raw({
            background: "red"
          })
        ).toEqual({
          vars: { "--alpha": "1" },
          background: `rgba(255, 0, 0, var(--alpha))`
        });
      });

      it("Boolean values for entire properties", () => {
        const { css } = defineRules({
          properties: {
            border: false,
            margin: true
          }
        });

        expect(css.raw({ margin: 8 })).toEqual({ margin: 8 });
      });

      it("Function values for CSS properties", () => {
        const { css } = defineRules({
          properties: {
            color(arg: "primary" | "secondary") {
              if (arg === "primary") {
                return "blue";
              } else {
                return "gray";
              }
            },
            otherColor(arg: "primary" | "secondary") {
              if (arg === "primary") {
                return { color: "red" } as const;
              } else {
                return { color: "green" } as const;
              }
            }
          }
        });

        expect(
          css.raw({
            color: "primary"
          })
        ).toEqual({
          color: "blue"
        });
        expect(
          css.raw({
            otherColor: "secondary"
          })
        ).toEqual({
          color: "green"
        });
      });

      it("Nullish values are treated as no-op", () => {
        const { css: cssProperty } = defineRules({
          properties: {
            color: true
          }
        });
        const undefinedColor: { color?: "red" } = {};
        const nullColor: { color?: "red" } = {};
        Object.assign(undefinedColor, { color: undefined });
        Object.assign(nullColor, { color: null });

        expect(cssProperty.raw([{ color: "red" }, undefinedColor])).toEqual({
          color: "red"
        });
        expect(cssProperty.raw([{ color: "red" }, nullColor])).toEqual({
          color: "red"
        });

        const { css: cssResolver } = defineRules({
          properties: {
            optionalColor(arg: "primary" | "none") {
              if (arg === "primary") {
                return { color: "blue" } as const;
              }
              return undefined;
            }
          }
        });

        expect(cssResolver.raw({ optionalColor: "none" })).toEqual({});
        expect(
          cssResolver.raw([
            { optionalColor: "primary" },
            { optionalColor: "none" }
          ])
        ).toEqual({ color: "blue" });
        expect(
          cssResolver([{ optionalColor: "primary" }, { optionalColor: "none" }])
        ).toBe(cssResolver({ optionalColor: "primary" }));
      });

      it("createDefineRulesRuntime supports function-valued properties locally", () => {
        const { css } = createDefineRulesRuntime({
          properties: {
            color(value: "brand" | "neutral") {
              if (value === "brand") {
                return "blue";
              }

              return "gray";
            },
            tone(value: "brand" | "neutral") {
              return {
                color: value === "brand" ? "blue" : "gray"
              } as const;
            },
            display: ["none", "flex"],
            paddingLeft: [0, 4, 8],
            paddingRight: [0, 4, 8]
          },
          shortcuts: {
            px: ["paddingLeft", "paddingRight"],
            center(value: "none" | "flex") {
              return {
                display: value,
                px: 4
              } as const;
            }
          }
        });

        expect(css.raw({ color: "brand" })).toEqual({
          color: "blue"
        });
        expect(css.raw({ color: "neutral" })).toEqual({
          color: "gray"
        });
        expect(css.raw({ tone: "neutral" })).toEqual({
          color: "gray"
        });
        expect(css.raw({ center: "flex" })).toEqual({
          display: "flex",
          paddingLeft: 4,
          paddingRight: 4
        });
        expect(css({ center: "flex" })).toBe(
          css({ display: "flex", paddingLeft: 4, paddingRight: 4 })
        );
      });

      it("css() canonicalize className", () => {
        const { css } = defineRules({
          debugId,
          properties: {
            color: true,
            background: true
          }
        });
        const colorRed = css({ color: "red" });
        const backgroundBlue = css({ background: "blue" });
        const combined = css({ color: "red", background: "blue" });
        const reversedCombined = css({ background: "blue", color: "red" });

        expect(colorRed).toMatch(identifierName(debugId));

        expect(colorRed).toBe(css({ color: "red" }));
        expect(backgroundBlue).toBe(css({ background: "blue" }));
        expect(combined).toBe(css({ color: "red", background: "blue" }));
        expect(reversedCombined).toBe(combined);
      });

      it("css() dedupes equivalent whole fragments when object key order differs", () => {
        const alpha = "--alpha";
        const { css } = defineRules({
          properties: {
            background(arg: { red: number; blue: number }) {
              const value = `rgb(${arg.red}, 0, ${arg.blue})`;

              if (Object.keys(arg)[0] === "red") {
                return {
                  vars: { [alpha]: "1" },
                  background: value
                } as const;
              }

              return {
                background: value,
                vars: { [alpha]: "1" }
              } as const;
            }
          }
        });

        expect(css({ background: { red: 255, blue: 255 } })).toBe(
          css({ background: { blue: 255, red: 255 } })
        );
      });

      it("Last one wins for properties", () => {
        const { css } = defineRules({
          properties: {
            color: true
          }
        });

        expect(css.raw([{ color: "red" }, { color: "blue" }])).toEqual({
          color: "blue"
        });
        expect(css([{ color: "red" }, { color: "blue" }])).toBe(
          css({ color: "blue" })
        );
      });

      it("Last one wins for properties while preserving sibling vars", () => {
        const alpha = "--alpha";
        const createCss = () =>
          defineRules({
            properties: {
              background: {
                red: {
                  vars: { [alpha]: "1" },
                  background: `rgba(255, 0, 0, var(${alpha}))`
                },
                blue: "rgb(0, 0, 255)"
              }
            }
          }).css;

        const cssRaw = createCss();

        expect(
          cssRaw.raw([{ background: "red" }, { background: "blue" }])
        ).toEqual({
          vars: { [alpha]: "1" },
          background: "rgb(0, 0, 255)"
        });

        const cssFullFirst = createCss();
        const fullRed = cssFullFirst({ background: "red" }).split(" ");
        const prunedAfterFull = cssFullFirst([
          { background: "red" },
          { background: "blue" }
        ]).split(" ");

        expect(fullRed).toHaveLength(1);
        expect(prunedAfterFull).toHaveLength(2);
        expect(prunedAfterFull[0]).not.toBe(fullRed[0]);

        const cssPrunedFirst = createCss();
        const prunedBeforeFull = cssPrunedFirst([
          { background: "red" },
          { background: "blue" }
        ]).split(" ");
        const fullAfterPruned = cssPrunedFirst({ background: "red" }).split(
          " "
        );

        expect(prunedBeforeFull).toHaveLength(2);
        expect(fullAfterPruned).toHaveLength(1);
        expect(fullAfterPruned[0]).not.toBe(prunedBeforeFull[0]);
      });
    });

    describe.concurrent("DefineRules Shortcuts", () => {
      it("Single property shortcut", () => {
        const { css } = defineRules({
          properties: {
            paddingLeft: [0, 4, 8],
            paddingRight: [0, 4, 8]
          },
          shortcuts: {
            pl: "paddingLeft",
            pr: "paddingRight"
          }
        });

        expect(css.raw({ pl: 4, pr: 8 })).toEqual({
          paddingLeft: 4,
          paddingRight: 8
        });
        expect(css.raw({ pl: 4, paddingLeft: 8 })).toEqual({
          paddingLeft: 8
        });
        expect(css.raw({ paddingLeft: 8, pl: 4 })).toEqual({
          paddingLeft: 4
        });
        expect(css({ pl: 4 })).toBe(css({ paddingLeft: 4 }));
      });

      it("Array shortcut referencing properties", () => {
        const { css } = defineRules({
          properties: {
            paddingLeft: [0, 4, 8],
            paddingRight: [0, 4, 8, 12]
          },
          shortcuts: {
            px: ["paddingLeft", "paddingRight"]
          }
        });

        expect(css.raw({ px: 4 })).toEqual({
          paddingLeft: 4,
          paddingRight: 4
        });
        expect(css.raw({ px: 4, paddingRight: 8 })).toEqual({
          paddingLeft: 4,
          paddingRight: 8
        });
        expect(css.raw({ paddingRight: 4, px: 8 })).toEqual({
          paddingLeft: 8,
          paddingRight: 8
        });
      });

      it("Shortcut referencing other shortcuts", () => {
        const { css } = defineRules({
          properties: {
            paddingLeft: [0, 4, 8],
            paddingRight: [0, 4, 8, 12]
          },
          shortcuts: {
            pl: "paddingLeft",
            pr: "paddingRight",
            px: ["pl", "pr"]
          }
        });

        expect(css.raw({ px: 4 })).toEqual({
          paddingLeft: 4,
          paddingRight: 4
        });
        expect(css.raw({ px: 4, paddingRight: 8 })).toEqual({
          paddingLeft: 4,
          paddingRight: 8
        });
        expect(css.raw({ paddingRight: 4, px: 8 })).toEqual({
          paddingLeft: 8,
          paddingRight: 8
        });
      });

      it("Mixed shortcuts with properties and other shortcuts", () => {
        const { css } = defineRules({
          properties: {
            paddingTop: [0, 4, 8],
            paddingBottom: [0, 4, 8],
            paddingLeft: [0, 4, 8],
            paddingRight: [0, 4, 8]
          },
          shortcuts: {
            pt: "paddingTop",
            pb: "paddingBottom",
            pl: "paddingLeft",
            pr: "paddingRight",
            py: ["pt", "pb"],
            px: ["pl", "pr"],
            p: ["py", "px"]
          }
        });

        expect(css.raw({ p: 4 })).toEqual({
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 4,
          paddingRight: 4
        });
        expect(css.raw({ p: 4, paddingLeft: 8 })).toEqual({
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 8,
          paddingRight: 4
        });
        expect(css.raw({ paddingLeft: 4, p: 8 })).toEqual({
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 8,
          paddingRight: 8
        });
        expect(css.raw({ p: 4, px: 8, pl: 0 })).toEqual({
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 0,
          paddingRight: 8
        });
        expect(css({ p: 4, px: 8, pl: 0 })).toBe(
          css([
            {
              paddingTop: 4,
              paddingBottom: 4,
              paddingLeft: 4,
              paddingRight: 4
            },
            {
              paddingLeft: 8,
              paddingRight: 8
            },
            {
              paddingLeft: 0
            }
          ])
        );
      });

      it("Fixed object shortcut", () => {
        const { css } = defineRules({
          properties: {
            display: ["none", "inline", "block"]
          },
          shortcuts: {
            inline: { display: "inline" }
          }
        });

        expect(css.raw({ inline: true })).toEqual({
          display: "inline"
        });
        expect(css.raw(["inline"])).toEqual({
          display: "inline"
        });
        expect(css.raw("inline")).toEqual({
          display: "inline"
        });
        expect(css.raw({ inline: true, display: "none" })).toEqual({
          display: "none"
        });
        expect(css.raw(["inline", { display: "none" }])).toEqual({
          display: "none"
        });
        expect(css.raw([{ display: "none", inline: true }])).toEqual({
          display: "inline"
        });
        expect(css.raw([{ display: "none" }, "inline"])).toEqual({
          display: "inline"
        });
      });

      it("Function shortcut", () => {
        const { css } = defineRules({
          properties: {
            display: ["none", "inline", "block"],
            paddingLeft: [0, 4, 8],
            paddingRight: [0, 4, 8]
          },
          shortcuts: {
            px: ["paddingLeft", "paddingRight"],
            center(arg: "none" | "inline" | "block") {
              return {
                display: arg,
                px: 4
              } as const;
            }
          }
        });

        expect(css.raw({ center: "inline" })).toEqual({
          display: "inline",
          paddingLeft: 4,
          paddingRight: 4
        });
        expect(css({ center: "inline" })).toBe(
          css({
            display: "inline",
            paddingLeft: 4,
            paddingRight: 4
          })
        );
        expect(css({ center: "inline" }).split(" ")).toHaveLength(3);
      });

      it("Circular shortcuts", () => {
        // @ts-expect-error Type of property 'a' circularly references itself in mapped type 'ShortcutsInput<PropertiesInput<{ readonly paddingLeft: readonly [0, 4, 8]; }>, { readonly a: "b"; readonly b: readonly ["a"]; }>'.
        const { css } = defineRules({
          properties: {
            paddingLeft: [0, 4, 8]
          },
          shortcuts: {
            a: "b",
            b: ["a"]
          }
        });

        expect(() => css.raw({ a: 4 })).toThrow(
          "Circular shortcut reference: a -> b -> a"
        );
      });
    });
  });
}
