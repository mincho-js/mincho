import { setFileScope } from "@vanilla-extract/css/fileScope";
import { identifierName } from "../utils.js";
import { createDefineRulesRuntime } from "./runtime.js";
import type { DefineRulesRuntimeResult } from "./runtime.js";
import type {
  DefineRulesCtx,
  DefineRulesPresetMap,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./types.js";

// == Define Rules =============================================================
export function defineRules<
  const Properties extends DefineRulesProperties,
  const Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  config: DefineRulesCtx<Properties, Shortcuts>
): DefineRulesRuntimeResult<Properties, Shortcuts> {
  const result: DefineRulesRuntimeResult<Properties, Shortcuts> =
    createDefineRulesRuntime<Properties, Shortcuts>(config);
  return result;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect, assertType } = import.meta.vitest;

  const debugId = "myCSS";
  setFileScope("test");

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
    assertType<DefineRulesPresetMap>(bindings.preset);
    assertType<DefineRulesAuthoringShapeInput>({
      color: "rebeccapurple",
      display: "flex"
    });

    expect(bindings.preset).toEqual({});
    expect(bindings.css.raw({ display: "flex" })).toEqual({
      display: "flex"
    });

    const className = bindings.css({ display: "flex" });

    expect(Object.values(bindings.preset)).toEqual([className]);
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
        assertType<DefineRulesPresetMap>(preset);
        expectDefineRulesAuthoringShapeBindings({ css, preset });
      });

      it("3. aliased destructuring form: export const { css: sharedCss, preset: sharedPreset } = defineRules({...})", () => {
        const { css: sharedCss, preset: sharedPreset } =
          createDefineRulesAuthoringShapeOwner("aliasedDestructuringShape");

        assertType<DefineRulesAuthoringShapeOwner["css"]>(sharedCss);
        assertType<DefineRulesPresetMap>(sharedPreset);
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
        assertType<DefineRulesPresetMap>(preset);
        expect(preset).toBe(presetOwner.preset);
        expectDefineRulesAuthoringShapeBindings({ css, preset });
      });

      it("5. exported owner-object destructuring form: export const presetOwner = defineRules({...}); export const { css, preset } = presetOwner;", () => {
        const presetOwner = createDefineRulesAuthoringShapeOwner(
          "exportedOwnerDestructuringShape"
        );
        const { css, preset } = presetOwner;

        assertType<DefineRulesAuthoringShapeOwner["css"]>(css);
        assertType<DefineRulesPresetMap>(preset);
        expect(preset).toBe(presetOwner.preset);
        expectDefineRulesAuthoringShapeBindings({ css, preset });
      });

      it("6. local destructuring export-list form: const { css, preset } = defineRules({...}); export { css, preset };", () => {
        const { css, preset } = createDefineRulesAuthoringShapeOwner(
          "localDestructuringExportListShape"
        );

        assertType<DefineRulesAuthoringShapeOwner["css"]>(css);
        assertType<DefineRulesPresetMap>(preset);
        expectDefineRulesAuthoringShapeBindings({ css, preset });
      });
    });

    describe.concurrent("DefineRules Presets", () => {
      it("exposes a live preset object", () => {
        const { css, preset } = defineRules({
          debugId: "presetIdentity",
          properties: {
            background: true
          }
        });

        expect(preset).toEqual({});

        const className = css({ background: "blue" });
        const repeatedClassName = css({ background: "blue" });

        expect(
          Object.keys(preset).every(
            (key) => key.startsWith("fragment_") === false
          )
        ).toBe(true);
        expect(repeatedClassName).toBe(className);
        expect(Object.values(preset)).toContain(className);
        expect(
          Object.values(preset).filter((entry) => entry === className)
        ).toHaveLength(1);
      });

      it("exposes an empty preset object without static calls", () => {
        const { preset } = defineRules({
          debugId: "emptyPresetIdentity",
          properties: {
            background: true
          }
        });

        expect(preset).toEqual({});
        expect(Object.keys(preset)).toHaveLength(0);
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
            ...provider.preset
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
            ...composed.preset
          },
          properties: {
            color: true,
            background: true,
            display: true
          }
        });
        const transitiveDisplay = transitive.css({ display: "block" });

        expect(Object.values(provider.preset)).toEqual([providerColor]);
        expect(Object.values(composed.preset)).toEqual(
          expect.arrayContaining([providerColor, composedBackground])
        );
        expect(Object.values(composed.preset)).toHaveLength(2);
        expect(Object.values(transitive.preset)).toEqual(
          expect.arrayContaining([
            providerColor,
            composedBackground,
            transitiveDisplay
          ])
        );
        expect(Object.values(transitive.preset)).toHaveLength(3);
        expect(composed.preset).not.toBe(provider.preset);
        expect(transitive.preset).not.toBe(composed.preset);
      });

      it("Rejects malformed preset input", () => {
        const createMalformedPresetCase = (presets: unknown) => () =>
          defineRules({
            presets: presets as DefineRulesPresetMap,
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
        const legacySerializedPresetEnvelope: unknown = {
          schema: "mincho.defineRulesPreset",
          version: 2,
          classNameByCache: {
            colorRed: "color_red"
          }
        };

        expect(createMalformedPresetCase(ownerPresetInput)).toThrow(
          "Unsupported defineRules preset input"
        );

        expect(
          createMalformedPresetCase(legacySerializedPresetEnvelope)
        ).toThrow("Unsupported defineRules preset input");

        expect(createMalformedPresetCase([])).toThrow(
          "Unsupported defineRules preset input"
        );
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
          ...provider.preset
        };

        const consumer = defineRules({
          debugId: "consumer",
          presets: importedPreset,
          properties: {
            background: true
          }
        });
        const presetHandle = consumer.preset;

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
        expect(presetHandle).toBe(consumer.preset);
        expect(importedPreset).toEqual(provider.preset);
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
          ...provider.preset
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

        expect(Object.values(consumerA.preset)).toEqual(
          expect.arrayContaining([providerColor, consumerABackground])
        );
        expect(Object.values(consumerA.preset)).toHaveLength(2);
        expect(Object.values(consumerB.preset)).toEqual([providerColor]);

        const consumerBBackground = consumerB.css({ background: "blue" });

        expect(consumerABackground).not.toBe(consumerBBackground);
        expect(Object.values(consumerB.preset)).toEqual(
          expect.arrayContaining([providerColor, consumerBBackground])
        );
        expect(Object.values(consumerB.preset)).not.toContain(
          consumerABackground
        );
        expect(sharedPreset).toEqual(provider.preset);
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
