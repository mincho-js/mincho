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
import { cx } from "../classname/cx.js";
import type { DefineRulesRuntimeResult } from "./runtime.js";
import {
  normalizeDefineRulesConditions,
  normalizeDefineRulesConditionValue
} from "./conditions.js";
import type {
  DefineRulesCtx,
  DefineRulesPresetArtifactV4,
  DefineRulesConditions,
  DefineRulesEmptyConditions,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./types.js";

const DEFINE_RULES_SERIALIZED_CSS_FUNCTION_CONFIG_DIAGNOSTIC =
  "defineRules serialized css does not support function-valued conditions, properties, or shortcuts";
const DEFINE_RULES_RUNTIME_IMPORT_PATH =
  "@mincho-js/css/defineRules/createDefineRulesCssRuntime";
const DEFINE_RULES_RUNTIME_IMPORT_NAME = "createDefineRulesCssRuntime";
const DEFINE_RULES_CX_RUNTIME_IMPORT_PATH =
  "@mincho-js/css/defineRules/createDefineRulesCxRuntime";
const DEFINE_RULES_CX_RUNTIME_IMPORT_NAME = "createDefineRulesCxRuntime";

// == Define Rules =============================================================
export function defineRules<
  const Properties extends DefineRulesProperties,
  const Shortcuts extends DefineRulesShortcuts<
    Properties,
    Shortcuts,
    Conditions
  >,
  const Conditions extends DefineRulesConditions = DefineRulesEmptyConditions
>(
  config: DefineRulesCtx<Properties, Shortcuts, Conditions>
): DefineRulesRuntimeResult<Properties, Shortcuts, Conditions> {
  const functionValuedConfigPath =
    getFunctionValuedDefineRulesConfigPath(config);
  const result: DefineRulesRuntimeResult<Properties, Shortcuts, Conditions> =
    createDefineRulesRuntime<Properties, Shortcuts, Conditions>(config, {
      registerPreset: functionValuedConfigPath == null
    });
  const serializedConfig = { ...config, presets: result.preset };

  return {
    ...result,
    cx: addDefineRulesCxSerializer(
      result.cx,
      createDefineRulesCxSerializerRecipe(
        serializedConfig as unknown as Serializable,
        functionValuedConfigPath
      )
    ),
    css: addFunctionSerializer(
      result.css,
      createDefineRulesSerializerRecipe(
        serializedConfig as unknown as Serializable,
        functionValuedConfigPath
      )
    ) as DefineRulesRuntimeResult<Properties, Shortcuts, Conditions>["css"]
  };
}

function addDefineRulesCxSerializer<CxFunction extends object>(
  cx: CxFunction,
  recipe: Parameters<typeof addFunctionSerializer>[1]
): CxFunction {
  if (Reflect.has(cx, "__recipe__")) {
    return cx;
  }

  return addFunctionSerializer(cx, recipe);
}

function createDefineRulesCxSerializerRecipe(
  serializedConfig: Serializable,
  functionValuedConfigPath: string | undefined
): Parameters<typeof addFunctionSerializer>[1] {
  if (functionValuedConfigPath != null) {
    return {
      importPath: DEFINE_RULES_CX_RUNTIME_IMPORT_PATH,
      importName: DEFINE_RULES_CX_RUNTIME_IMPORT_NAME,
      get args(): ReadonlyArray<Serializable> {
        throw new Error(
          createFunctionValuedConfigDiagnostic(functionValuedConfigPath)
        );
      }
    };
  }

  return {
    importPath: DEFINE_RULES_CX_RUNTIME_IMPORT_PATH,
    importName: DEFINE_RULES_CX_RUNTIME_IMPORT_NAME,
    args: [serializedConfig]
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
  conditions?: object;
  properties?: object;
  shortcuts?: object;
}): string | undefined {
  return (
    getFunctionValuedEntriesPath(config.conditions, "config.conditions") ??
    getFunctionValuedEntriesPath(config.properties, "config.properties") ??
    getFunctionValuedEntriesPath(config.shortcuts, "config.shortcuts")
  );
}

function getFunctionValuedEntriesPath(
  entry: unknown,
  path: string,
  seenEntries: WeakSet<object> = new WeakSet()
): string | undefined {
  if (typeof entry === "function") {
    return path;
  }

  if (entry == null || typeof entry !== "object") {
    return undefined;
  }

  if (seenEntries.has(entry)) {
    return undefined;
  }
  seenEntries.add(entry);

  if (Array.isArray(entry)) {
    for (let index = 0; index < entry.length; index += 1) {
      const nestedPath = getFunctionValuedEntriesPath(
        entry[index],
        `${path}[${index}]`,
        seenEntries
      );
      if (nestedPath != null) return nestedPath;
    }
    return undefined;
  }

  for (const [key, value] of Object.entries(entry)) {
    const nestedPath = getFunctionValuedEntriesPath(
      value,
      `${path}${formatConfigPathSegment(key)}`,
      seenEntries
    );
    if (nestedPath != null) return nestedPath;
  }

  return undefined;
}

function formatConfigPathSegment(key: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) {
    return `.${key}`;
  }

  return `[${JSON.stringify(key)}]`;
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
  type DefineRulesAuthoringShapeBindings = Pick<
    DefineRulesAuthoringShapeOwner,
    "css" | "cx" | "preset"
  >;
  type DefineRulesAuthoringShapeInput = Parameters<
    DefineRulesAuthoringShapeOwner["css"]
  >[0];

  function expectDefineRulesAuthoringShapeBindings(
    bindings: DefineRulesAuthoringShapeBindings
  ) {
    assertType<DefineRulesAuthoringShapeOwner["css"]>(bindings.css);
    assertType<DefineRulesAuthoringShapeOwner["cx"]>(bindings.cx);
    assertType<DefineRulesPresetArtifactV4>(bindings.preset);
    assertType<DefineRulesAuthoringShapeInput>({
      color: "rebeccapurple",
      display: "flex"
    });

    expect(bindings.preset).toEqual({
      schema: "mincho.defineRulesPreset",
      version: 4,
      classNameByCache: expect.any(Object),
      writeKeyByCacheKey: expect.any(Object),
      conditionById: expect.any(Object),
      propertyById: expect.any(Object),
      writeKeyById: expect.any(Object)
    });
    expect(bindings.cx).not.toBe(cx);
    expect(bindings.cx("external external", "external")).toBe(
      cx("external external", "external")
    );
    const className = bindings.css({ display: "flex" });

    expect(bindings.cx(className, "external")).toBe(`${className} external`);
    expect(bindings.css.raw({ display: "flex" })).toEqual({
      display: "flex"
    });

    expect(Object.values(bindings.preset.classNameByCache)).toEqual([
      className
    ]);
  }

  describe("defineRules", () => {
    describe.concurrent("DefineRules authoring/export shape matrix", () => {
      it("1. owner-object form: export const presetOwner = defineRules({...})", () => {
        const presetOwner =
          createDefineRulesAuthoringShapeOwner("ownerObjectShape");
        const className = presetOwner.css({ display: "flex" });

        assertType<DefineRulesAuthoringShapeOwner>(presetOwner);
        expect(presetOwner.cx(className, "external")).toBe(
          `${className} external`
        );
        expectDefineRulesAuthoringShapeBindings(presetOwner);
      });

      it("2. direct destructuring form: export const { css, cx, preset } = defineRules({...})", () => {
        const { css, cx, preset } = createDefineRulesAuthoringShapeOwner(
          "directDestructuringShape"
        );
        const className = css({ display: "flex" });

        assertType<DefineRulesAuthoringShapeOwner["css"]>(css);
        assertType<DefineRulesAuthoringShapeOwner["cx"]>(cx);
        assertType<DefineRulesPresetArtifactV4>(preset);
        expect(cx(className, "external")).toBe(`${className} external`);
        expectDefineRulesAuthoringShapeBindings({ css, cx, preset });
      });

      it("3. aliased destructuring form: export const { css: sharedCss, cx: compose, preset: sharedPreset } = defineRules({...})", () => {
        const {
          css: sharedCss,
          cx: compose,
          preset: sharedPreset
        } = createDefineRulesAuthoringShapeOwner("aliasedDestructuringShape");
        const className = sharedCss({ display: "flex" });

        assertType<DefineRulesAuthoringShapeOwner["css"]>(sharedCss);
        assertType<DefineRulesAuthoringShapeOwner["cx"]>(compose);
        assertType<DefineRulesPresetArtifactV4>(sharedPreset);
        expect(compose(className, "external")).toBe(`${className} external`);
        expectDefineRulesAuthoringShapeBindings({
          css: sharedCss,
          cx: compose,
          preset: sharedPreset
        });
      });

      it("4. owner-object member exports form: const presetOwner = defineRules({...}); export const css = presetOwner.css; export const cx = presetOwner.cx; export const preset = presetOwner.preset;", () => {
        const presetOwner = createDefineRulesAuthoringShapeOwner(
          "ownerMemberExportsShape"
        );
        const css = presetOwner.css;
        const compose = presetOwner.cx;
        const preset = presetOwner.preset;

        assertType<DefineRulesAuthoringShapeOwner["css"]>(css);
        assertType<DefineRulesAuthoringShapeOwner["cx"]>(compose);
        assertType<DefineRulesPresetArtifactV4>(preset);
        expect(preset).toBe(presetOwner.preset);
        expectDefineRulesAuthoringShapeBindings({ css, cx: compose, preset });
      });

      it("5. exported owner-object destructuring form: export const presetOwner = defineRules({...}); export const { css, cx, preset } = presetOwner;", () => {
        const presetOwner = createDefineRulesAuthoringShapeOwner(
          "exportedOwnerDestructuringShape"
        );
        const { css, cx: compose, preset } = presetOwner;

        assertType<DefineRulesAuthoringShapeOwner["css"]>(css);
        assertType<DefineRulesAuthoringShapeOwner["cx"]>(compose);
        assertType<DefineRulesPresetArtifactV4>(preset);
        expect(preset).toBe(presetOwner.preset);
        expectDefineRulesAuthoringShapeBindings({ css, cx: compose, preset });
      });

      it("6. local destructuring export-list form: const { css, cx, preset } = defineRules({...}); export { css, cx, preset };", () => {
        const { css, cx, preset } = createDefineRulesAuthoringShapeOwner(
          "localDestructuringExportListShape"
        );

        assertType<DefineRulesAuthoringShapeOwner["css"]>(css);
        assertType<DefineRulesAuthoringShapeOwner["cx"]>(cx);
        assertType<DefineRulesPresetArtifactV4>(preset);
        expectDefineRulesAuthoringShapeBindings({ css, cx, preset });
      });

      it("7. public defineRules signature accepts only config", () => {
        const assertRemovedPrivateArgument = () => {
          // @ts-expect-error defineRules only accepts a single config argument.
          defineRules({ properties: { color: true } }, "anything");
        };

        expect(assertRemovedPrivateArgument).toEqual(expect.any(Function));
      });
    });

    describe.concurrent("DefineRules Conditions", () => {
      const createConditionConfigCase =
        (conditions: DefineRulesConditions) => () =>
          createDefineRulesRuntime({
            conditions,
            properties: {
              color: true
            }
          });

      it("validates configured condition aliases without runtime condition emission", () => {
        const { css } = defineRules({
          conditions: {
            mobile: {},
            tablet: "@media screen and (min-width: 768px)",
            desktop: {
              "@media": "screen and (min-width: 1024px)"
            },
            supportsGrid: {
              "@supports": "(display: grid)"
            }
          },
          properties: {
            color: true,
            display: ["none", "flex"]
          }
        });

        expect(
          css.raw({
            color: "red",
            display: "flex"
          })
        ).toEqual({
          color: "red",
          display: "flex"
        });
      });

      it("returns nested raw rules and condition metadata for configured aliases", () => {
        const { css, preset } = defineRules({
          debugId: "conditionalRuntime",
          conditions: {
            tablet: "@media screen and (min-width: 768px)",
            supportsGrid: {
              "@supports": "(display: grid)",
              selector: "&[data-grid]"
            },
            containerLayer: {
              "@layer": "components",
              "@container": "(min-width: 32rem)"
            }
          },
          properties: {
            color: true,
            display: true,
            fontSize: true
          }
        });

        const input = {
          color: {
            base: "red",
            _tablet: "blue"
          },
          _tablet: {
            display: "flex"
          },
          _supportsGrid: {
            fontSize: 16
          },
          _containerLayer: {
            color: "green"
          }
        } as const;

        const className = css(input);

        expect(css.raw(input)).toEqual({
          color: "red",
          "@media": {
            "screen and (min-width: 768px)": {
              color: "blue",
              display: "flex"
            }
          },
          "@supports": {
            "(display: grid)": {
              selectors: {
                "&[data-grid]": {
                  fontSize: 16
                }
              }
            }
          },
          "@layer": {
            components: {
              "@container": {
                "(min-width: 32rem)": {
                  color: "green"
                }
              }
            }
          }
        });
        expect(className.split(" ")).toHaveLength(5);
        expect(Object.values(preset.conditionById)).toEqual(
          expect.arrayContaining([
            {
              layer: null,
              supports: null,
              media: "screen and (min-width: 768px)",
              container: null,
              selector: "&"
            },
            {
              layer: null,
              supports: "(display: grid)",
              media: null,
              container: null,
              selector: "&[data-grid]"
            },
            {
              layer: "components",
              supports: null,
              media: null,
              container: "(min-width: 32rem)",
              selector: "&"
            }
          ])
        );
        expect(Object.values(preset.propertyById)).toEqual(
          expect.arrayContaining(["color", "display", "fontSize"])
        );
      });

      it("normalizes empty object conditions to the transform base alias value", () => {
        expect(
          normalizeDefineRulesConditions({
            mobile: {}
          })
        ).toEqual({
          _mobile: {}
        });
      });

      it("canonicalizes string and object media condition configs", () => {
        expect(
          normalizeDefineRulesConditionValue(
            "@media screen and (min-width: 768px)",
            "tablet"
          )
        ).toBe("screen and (min-width: 768px)");
        expect(
          normalizeDefineRulesConditionValue(
            {
              "@media": "@media screen and (min-width: 768px)"
            },
            "tablet"
          )
        ).toEqual({
          "@media": "screen and (min-width: 768px)"
        });
      });

      it("throws clear runtime diagnostics for invalid and reserved condition names", () => {
        expect(createConditionConfigCase({ hover: {} })).toThrow(
          'Reserved defineRules condition alias "_hover"'
        );
        expect(createConditionConfigCase({ media: {} })).toThrow(
          'Reserved defineRules condition alias "_media"'
        );
        expect(createConditionConfigCase({ _mobile: {} })).toThrow(
          'Invalid defineRules condition name "_mobile"'
        );
        expect(createConditionConfigCase({ "@mobile": {} })).toThrow(
          'Invalid defineRules condition name "@mobile"'
        );
      });

      it("throws clear runtime diagnostics for invalid condition object keys", () => {
        expect(
          createConditionConfigCase({
            mobile: {
              unknown: "x"
            } as never
          })
        ).toThrow('Unsupported defineRules condition key "unknown"');
      });
    });

    describe.concurrent("DefineRules cx", () => {
      it("keeps only the later known class for the same condition and property", () => {
        const { css, cx: scopedCx } = defineRules({
          debugId: "cxSameConditionProperty",
          conditions: {
            desktop: {
              "@media": "screen and (min-width: 1024px)"
            }
          },
          properties: {
            color: true
          }
        });
        const desktopPrimary = css({ _desktop: { color: "primary" } });
        const desktopInverse = css({ _desktop: { color: "inverse" } });

        expect(scopedCx(desktopPrimary, desktopInverse)).toBe(desktopInverse);
      });

      it("keeps known classes for different conditions", () => {
        const { css, cx: scopedCx } = defineRules({
          debugId: "cxDifferentConditions",
          conditions: {
            mobile: {},
            desktop: {
              "@media": "screen and (min-width: 1024px)"
            }
          },
          properties: {
            color: true
          }
        });
        const mobileMuted = css({ _mobile: { color: "muted" } });
        const desktopInverse = css({ _desktop: { color: "inverse" } });

        expect(scopedCx(mobileMuted, desktopInverse)).toBe(
          `${mobileMuted} ${desktopInverse}`
        );
      });

      it("preserves unknown duplicate strings in order around known classes", () => {
        const owner = defineRules({
          debugId: "cxUnknownDuplicateOrder",
          properties: {
            color: true
          }
        });
        const colorRed = owner.css({ color: "red" });

        expect(owner.cx("external external", colorRed, "external")).toBe(
          `external external ${colorRed} external`
        );
      });

      it("keeps unknown-only output compatible while returning a scoped cx", () => {
        const owner = createDefineRulesAuthoringShapeOwner("cxScopedIdentity");

        expect(owner.cx).not.toBe(cx);
        expect(owner.cx("external", ["external"], { active: true })).toBe(
          cx("external", ["external"], { active: true })
        );
      });

      it("uses hydrated write-key metadata to merge known atomic classes", () => {
        const provider = defineRules({
          debugId: "cxProvider",
          properties: {
            color: true,
            background: true
          }
        });
        const providerColor = provider.css({ color: "red" });
        const providerBackground = provider.css({ background: "blue" });
        const consumer = defineRules({
          debugId: "cxConsumer",
          presets: provider.preset,
          properties: {
            color: true,
            background: true
          }
        });

        expect(consumer.cx(providerColor, providerColor)).toBe(providerColor);
        expect(
          consumer.cx(providerColor, providerBackground, providerColor)
        ).toBe(`${providerBackground} ${providerColor}`);
      });

      it("filters falsy values like root cx", () => {
        const owner = createDefineRulesAuthoringShapeOwner("cxFalsyFilter");

        expect(owner.cx("a", false, undefined, null, "b")).toBe(
          cx("a", false, undefined, null, "b")
        );
      });

      it("merges known atomic classes in cx.multiple()", () => {
        const owner = createDefineRulesAuthoringShapeOwner("cxMultiple");
        const displayNone = owner.css({ display: "none" });
        const displayFlex = owner.css({ display: "flex" });
        const result = owner.cx.multiple({
          base: displayNone,
          active: [displayNone, displayFlex]
        });

        expect(result).toEqual({ base: displayNone, active: displayFlex });
      });

      it("merges known atomic classes through cx.with() and with().multiple()", () => {
        const owner = createDefineRulesAuthoringShapeOwner("cxWithKnownMerge");
        const displayNone = owner.css({ display: "none" });
        const displayFlex = owner.css({ display: "flex" });
        const composed = owner.cx.with<{
          base: string;
          override?: string;
        }>(({ base, override }) => [base, override]);

        expect(composed({ base: displayNone, override: displayFlex })).toBe(
          displayFlex
        );
        expect(
          composed.multiple({
            inactive: { base: displayNone },
            active: { base: displayNone, override: displayFlex }
          })
        ).toEqual({ inactive: displayNone, active: displayFlex });
      });

      it("preserves repeated full cx inputs while using the private full-result cache", () => {
        const owner = defineRules({
          debugId: "cxRepeatedFullInput",
          properties: {
            background: true,
            color: true
          }
        });
        const colorRed = owner.css({ color: "red" });
        const colorBlue = owner.css({ color: "blue" });
        const backgroundBlue = owner.css({ background: "blue" });
        const expected = `external external ${backgroundBlue} ${colorBlue} external`;

        expect(
          owner.cx(
            "external external",
            colorRed,
            backgroundBlue,
            colorBlue,
            "external"
          )
        ).toBe(expected);
        expect(
          owner.cx(
            "external external",
            colorRed,
            backgroundBlue,
            colorBlue,
            "external"
          )
        ).toBe(expected);
      });

      it("supports typed constraints and runtime composition", () => {
        type LayoutClass = "flex" | "grid" | "block";

        const owner = createDefineRulesAuthoringShapeOwner("cxWith");
        const constrained = owner.cx.with<LayoutClass>();

        assertType<(...classNames: LayoutClass[]) => string>(constrained);
        expect(constrained("flex", "grid")).toBe("flex grid");

        const composed = owner.cx.with<{
          base: string;
          active?: string;
        }>(({ base, active }) => [base, active && `active-${active}`]);

        assertType<(params: { base: string; active?: string }) => string>(
          composed
        );
        expect(composed({ base: "btn", active: "primary" })).toBe(
          "btn active-primary"
        );
      });
    });

    describe("DefineRules Registry", () => {
      it("registers live v4 preset artifacts with deferred snapshots", () => {
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
            provider.preset
          );
          expect(session.instances[1]?.getPresetSnapshot()).toEqual(
            middle.preset
          );
          expect(session.instances[2]?.getPresetSnapshot()).toEqual(
            consumer.preset
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
    });

    describe.concurrent("DefineRules Presets", () => {
      const createEmptyPresetArtifact = (): DefineRulesPresetArtifactV4 => ({
        schema: "mincho.defineRulesPreset",
        version: 4,
        classNameByCache: {},
        writeKeyByCacheKey: {},
        conditionById: {},
        propertyById: {},
        writeKeyById: {}
      });

      const clonePresetArtifact = (
        preset: DefineRulesPresetArtifactV4
      ): DefineRulesPresetArtifactV4 => ({
        schema: "mincho.defineRulesPreset",
        version: 4,
        classNameByCache: { ...preset.classNameByCache },
        writeKeyByCacheKey: { ...preset.writeKeyByCacheKey },
        conditionById: Object.fromEntries(
          Object.entries(preset.conditionById).map(
            ([conditionId, condition]) => [conditionId, { ...condition }]
          )
        ),
        propertyById: { ...preset.propertyById },
        writeKeyById: Object.fromEntries(
          Object.entries(preset.writeKeyById).map(([writeKeyId, writeKey]) => [
            writeKeyId,
            { ...writeKey }
          ])
        )
      });

      it("exposes a live v4 preset object through the serializer recipe", () => {
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
        expect(Object.keys(preset)).toEqual([
          "schema",
          "version",
          "classNameByCache",
          "writeKeyByCacheKey",
          "conditionById",
          "propertyById",
          "writeKeyById"
        ]);
        expect(preset).not.toHaveProperty("registeredSegments");
        expect(preset).not.toHaveProperty("segmentCache");
        expect(preset).not.toHaveProperty("fullResultCache");
        expect(preset).not.toHaveProperty("cx");
        expect(preset).not.toHaveProperty("atomicClassByClassName");

        const className = css({ background: "blue" });
        const repeatedClassName = css({ background: "blue" });

        expect(repeatedClassName).toBe(className);
        expect(Object.values(preset.classNameByCache)).toContain(className);
        expect(Object.values(preset.classNameByCache)).toHaveLength(1);
        expect(Object.keys(preset.writeKeyByCacheKey)).toEqual(
          Object.keys(preset.classNameByCache)
        );
        expect(JSON.stringify(preset).split(className)).toHaveLength(2);
      });

      it("serializes an empty v4 preset object without static calls", () => {
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
        expect(preset).toEqual(createEmptyPresetArtifact());
      });

      it("keeps serialized runtime v4 preset handles live for later static css calls", async () => {
        const { createDefineRulesCssRuntime } =
          await import("./createDefineRulesCssRuntime.js");
        const preset = createEmptyPresetArtifact();
        const css = createDefineRulesCssRuntime({
          debugId: "serializedRuntimePresetHandle",
          properties: {
            background: true
          },
          presets: preset
        });

        const className = css({ background: "blue" });

        expect(Object.values(preset.classNameByCache)).toEqual([className]);
        expect(Object.keys(preset.writeKeyByCacheKey)).toEqual(
          Object.keys(preset.classNameByCache)
        );
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
        const createSerializerArgsReader = (config: unknown) => {
          const recipe = createDefineRulesSerializerRecipe(
            {} as Serializable,
            getFunctionValuedDefineRulesConfigPath(config as never)
          );

          return () => recipe.args;
        };

        expect(
          createRecipeArgsReader({
            properties: {
              color(value: string) {
                return value;
              }
            }
          })
        ).toThrow(
          createFunctionValuedConfigDiagnostic("config.properties.color")
        );
        expect(
          createRecipeArgsReader({
            properties: {
              palette: {
                brand: {
                  tone(value: string) {
                    return {
                      color: value
                    } as const;
                  }
                }
              }
            }
          })
        ).toThrow(
          createFunctionValuedConfigDiagnostic(
            "config.properties.palette.brand.tone"
          )
        );
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
        ).toThrow(
          createFunctionValuedConfigDiagnostic("config.shortcuts.tone")
        );
        expect(
          createRecipeArgsReader({
            properties: {
              color: true
            },
            shortcuts: {
              layout: [
                "color",
                {
                  tone(value: "red" | "blue") {
                    return {
                      color: value
                    } as const;
                  }
                }
              ]
            }
          })
        ).toThrow(
          createFunctionValuedConfigDiagnostic(
            "config.shortcuts.layout[1].tone"
          )
        );
        expect(
          createSerializerArgsReader({
            conditions: {
              dynamic: {
                selector(value: string) {
                  return value;
                }
              }
            }
          })
        ).toThrow(
          createFunctionValuedConfigDiagnostic(
            "config.conditions.dynamic.selector"
          )
        );

        expect(
          createRecipeArgsReader({
            conditions: {
              mobile: {},
              tablet: "screen and (min-width: 768px)",
              desktop: {
                "@media": "@media screen and (min-width: 1024px)",
                selector: "&[data-desktop]"
              }
            },
            properties: {
              color: true
            },
            shortcuts: {
              badge: {
                color: "red"
              }
            }
          })()
        ).toEqual([
          expect.objectContaining({
            conditions: {
              mobile: {},
              tablet: "screen and (min-width: 768px)",
              desktop: {
                "@media": "@media screen and (min-width: 1024px)",
                selector: "&[data-desktop]"
              }
            }
          })
        ]);
      });

      it("imports v4 preset artifacts by remapping metadata and copying class cache", () => {
        const provider = defineRules({
          debugId: "v4Provider",
          properties: {
            color: true
          }
        });
        const providerColor = provider.css({ color: "red" });
        const artifact = clonePresetArtifact(provider.preset);
        const artifactSnapshot = clonePresetArtifact(artifact);

        const consumer = defineRules({
          debugId: "v4Consumer",
          presets: artifact,
          properties: {
            color: true,
            background: true
          }
        });

        expect(consumer.preset.classNameByCache).toEqual(
          artifactSnapshot.classNameByCache
        );
        expect(consumer.preset.classNameByCache).not.toBe(
          artifact.classNameByCache
        );
        expect(consumer.css({ color: "red" })).toBe(providerColor);

        const consumerBackground = consumer.css({ background: "blue" });

        expect(Object.values(consumer.preset.classNameByCache)).toEqual(
          expect.arrayContaining([providerColor, consumerBackground])
        );
        expect(Object.values(consumer.preset.classNameByCache)).toHaveLength(2);
        expect(artifact).toEqual(artifactSnapshot);
      });

      it("merges recursive v4 preset input arrays without mutating imports", () => {
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
        const displayArtifact = clonePresetArtifact(displayProvider.preset);
        const displayArtifactSnapshot = clonePresetArtifact(displayArtifact);

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
        expect(displayArtifact).toEqual(displayArtifactSnapshot);
      });

      it("reuses imported v4 preset class names without overwriting entries", () => {
        const provider = defineRules({
          debugId: "provider",
          properties: {
            background: true
          }
        });
        const providerBackground = provider.css({ background: "blue" });
        const importedPreset = clonePresetArtifact(provider.preset);
        const importedSnapshot = clonePresetArtifact(importedPreset);

        const consumer = defineRules({
          debugId: "consumer",
          presets: importedPreset,
          properties: {
            background: true
          }
        });
        const presetHandle = consumer.preset.classNameByCache;

        expect(presetHandle).toEqual(importedSnapshot.classNameByCache);

        const reusedBackground = consumer.css({ background: "blue" });

        expect(reusedBackground).toBe(providerBackground);
        expect(reusedBackground).not.toMatch(identifierName("consumer"));
        expect(presetHandle).toEqual(importedSnapshot.classNameByCache);
        expect(Object.values(presetHandle)).toEqual([providerBackground]);
        expect(
          Object.values(presetHandle).filter(
            (className) => className === reusedBackground
          )
        ).toHaveLength(1);
        expect(presetHandle).toBe(consumer.preset.classNameByCache);
        expect(importedPreset).toEqual(importedSnapshot);
      });

      it("keeps imported v4 preset handles isolated across defineRules instances", () => {
        const provider = defineRules({
          debugId: "provider",
          properties: {
            color: true
          }
        });
        const providerColor = provider.css({ color: "red" });
        const sharedPreset = clonePresetArtifact(provider.preset);
        const sharedSnapshot = clonePresetArtifact(sharedPreset);

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
        expect(sharedPreset).toEqual(sharedSnapshot);
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

      it("css() reuses atomic class names while preserving source order", () => {
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
        expect(combined).toBe(`${colorRed} ${backgroundBlue}`);
        expect(reversedCombined).toBe(`${backgroundBlue} ${colorRed}`);
      });

      it("preserves surviving class source order instead of lexicographic order", () => {
        const { css } = defineRules({
          debugId: "sourceOrderRuntime",
          properties: {
            alignItems: true,
            background: true,
            borderColor: true,
            color: true,
            opacity: true,
            zIndex: true
          }
        });
        const candidates = [
          { color: "red" },
          { background: "blue" },
          { borderColor: "green" },
          { alignItems: "center" },
          { opacity: 0.5 },
          { zIndex: 1 }
        ] as const;
        const entries = candidates.map((input) => ({
          input,
          className: css(input)
        }));
        const [lexicographicFirst, sourceFirst] = [...entries].sort((a, b) =>
          a.className.localeCompare(b.className)
        );

        expect(sourceFirst).toBeDefined();
        expect(lexicographicFirst).toBeDefined();
        if (sourceFirst == null || lexicographicFirst == null) return;
        expect(sourceFirst.className > lexicographicFirst.className).toBe(true);

        expect(css([sourceFirst.input, lexicographicFirst.input])).toBe(
          `${sourceFirst.className} ${lexicographicFirst.className}`
        );
      });

      it("css() reuses equivalent atomic fragments when object key order differs", () => {
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

        const redFirstClassNames = css({
          background: { red: 255, blue: 255 }
        }).split(" ");
        const blueFirstClassNames = css({
          background: { blue: 255, red: 255 }
        }).split(" ");

        expect(new Set(redFirstClassNames)).toEqual(
          new Set(blueFirstClassNames)
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

        expect(fullRed).toHaveLength(2);
        expect(prunedAfterFull).toHaveLength(2);
        expect(prunedAfterFull[0]).toBe(fullRed[0]);
        expect(prunedAfterFull[1]).not.toBe(fullRed[1]);

        const cssPrunedFirst = createCss();
        const prunedBeforeFull = cssPrunedFirst([
          { background: "red" },
          { background: "blue" }
        ]).split(" ");
        const fullAfterPruned = cssPrunedFirst({ background: "red" }).split(
          " "
        );

        expect(prunedBeforeFull).toHaveLength(2);
        expect(fullAfterPruned).toHaveLength(2);
        expect(fullAfterPruned[0]).toBe(prunedBeforeFull[0]);
        expect(fullAfterPruned[1]).not.toBe(prunedBeforeFull[1]);
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

      it("resolves shortcut conflicts by transformed property within each condition", () => {
        const { css } = defineRules({
          conditions: {
            tablet: "@media screen and (min-width: 768px)"
          },
          properties: {
            padding: true,
            paddingLeft: true,
            paddingRight: true
          },
          shortcuts: {
            px(value: 4 | 8) {
              return {
                padding: {
                  Left: value,
                  Right: value
                }
              } as const;
            }
          }
        });

        expect(
          css.raw({
            px: {
              _tablet: 4
            },
            paddingLeft: {
              _tablet: 8
            }
          })
        ).toEqual({
          "@media": {
            "screen and (min-width: 768px)": {
              paddingRight: 4,
              paddingLeft: 8
            }
          }
        });
        expect(
          css({
            px: {
              _tablet: 4
            },
            paddingLeft: {
              _tablet: 8
            }
          })
        ).toBe(
          css({
            paddingRight: {
              _tablet: 4
            },
            paddingLeft: {
              _tablet: 8
            }
          })
        );
        expect(
          css.raw({
            px: 4,
            paddingLeft: {
              _tablet: 8
            }
          })
        ).toEqual({
          paddingLeft: 4,
          paddingRight: 4,
          "@media": {
            "screen and (min-width: 768px)": {
              paddingLeft: 8
            }
          }
        });
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
