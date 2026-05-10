import type {
  NonNullableString,
  CSSProperties,
  CSSRule,
  CSSPropertiesWithVars
} from "@mincho-js/transform-to-vanilla";
import type {
  DefineRulesConditionAliasKey,
  DefineRulesConditions,
  NormalizedCondition
} from "./conditions.js";
export type DefineRulesEmptyConditions = Record<never, never>;
export type {
  DefineRulesCondition,
  DefineRulesConditionAliasKey,
  DefineRulesConditions
} from "./conditions.js";

type CSSPropertiesKeys = keyof CSSProperties;

type DefineRulesValueResolver<
  Out = CSSPropertiesWithVars | undefined,
  Arg = unknown
> = {
  bivarianceHack(arg: Arg): Out;
}["bivarianceHack"];

type DefineRulesCssProperties = {
  [Property in CSSPropertiesKeys]?: DefineRulesCssPropertiesValue<
    CSSProperties[Property]
  >;
};
type DefineRulesCssPropertiesValue<Value> =
  | ReadonlyArray<Value>
  | Record<string, Value | CSSPropertiesWithVars>
  | DefineRulesValueResolver<Value>
  | true
  | false;

type DefineRulesCustomProperties = Partial<
  Record<
    Exclude<NonNullableString, CSSPropertiesKeys>,
    Record<string, CSSPropertiesWithVars> | DefineRulesValueResolver
  >
>;
export type DefineRulesProperties =
  | DefineRulesCssProperties
  | DefineRulesCustomProperties;

type ShortcutValue<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  ShortcutsKey extends keyof Shortcuts,
  Conditions extends DefineRulesConditions = DefineRulesEmptyConditions
> =
  | keyof Properties
  | Exclude<keyof Shortcuts, ShortcutsKey>
  | ReadonlyArray<keyof Properties | Exclude<keyof Shortcuts, ShortcutsKey>>
  | DefineRulesNestedCssInput<Properties, Shortcuts, Conditions>
  | DefineRulesValueResolver<
      DefineRulesNestedCssInput<Properties, Shortcuts, Conditions>
    >;

export type DefineRulesShortcuts<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions = DefineRulesEmptyConditions
> = {
  [ShortcutsKey in keyof Shortcuts]: ShortcutValue<
    Properties,
    Shortcuts,
    ShortcutsKey,
    Conditions
  >;
};

export interface DefineRulesPresetCompiledKnownEntry {
  kind: "known";
  className: string;
  writeKeyId: number;
}

export interface DefineRulesPresetCompiledUnknownEntry {
  kind: "unknown";
  className: string;
}

export type DefineRulesPresetCompiledEntry =
  | DefineRulesPresetCompiledKnownEntry
  | DefineRulesPresetCompiledUnknownEntry;

export interface DefineRulesPresetCompiledSegment {
  entries: DefineRulesPresetCompiledEntry[];
  hasKnownAtomicClass: boolean;
}

export type DefineRulesPresetClassNameByCache = Record<string, string>;

export type DefineRulesPresetArtifactV3 = {
  schema: "mincho.defineRulesPreset";
  version: 3;
  classNameByCache: DefineRulesPresetClassNameByCache;
};

export interface DefineRulesPresetWriteKey {
  conditionId: number;
  propertyId: number;
}

export type DefineRulesPresetArtifactV4 = {
  schema: "mincho.defineRulesPreset";
  version: 4;
  classNameByCache: DefineRulesPresetClassNameByCache;
  writeKeyByCacheKey: Record<string, number>;
  conditionById: Record<number, NormalizedCondition>;
  propertyById: Record<number, string>;
  writeKeyById: Record<number, DefineRulesPresetWriteKey>;
};

export type DefineRulesPresetInput =
  | DefineRulesPresetArtifactV3
  | DefineRulesPresetArtifactV4
  | DefineRulesPresetClassNameByCache
  | readonly DefineRulesPresetInput[];

export type DefineRulesPresetMap = DefineRulesPresetClassNameByCache;

export interface DefineRulesCss<CssInput> {
  (args: CssInput): string;
  raw(args: CssInput): CSSRule;
}

export interface DefineRulesCtx<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions = DefineRulesEmptyConditions
> {
  debugId?: string;
  presets?: DefineRulesPresetInput;
  conditions?: Conditions;
  properties?: Properties;
  shortcuts?: Shortcuts;
}

type PropertiesInput<
  Properties extends DefineRulesProperties,
  Conditions extends DefineRulesConditions
> = {
  [Key in keyof Properties]?: ResolveConditionableValue<
    ResolvePropertiesValue<Key, Properties[Key]>,
    Conditions
  >;
};

type ResolveConditionableValue<
  Value,
  Conditions extends DefineRulesConditions
> = Value | DefineRulesPropertyConditionInput<Value, Conditions>;

type DefineRulesPropertyConditionInput<
  Value,
  Conditions extends DefineRulesConditions
> = keyof Conditions extends never
  ? never
  : { base?: Value } & {
      [Alias in DefineRulesConditionAliasKey<Conditions>]?: ResolveConditionableValue<
        Value,
        Conditions
      >;
    };

type ResolvePropertiesValue<Key, Value> =
  Value extends ReadonlyArray<infer Item>
    ? Item
    : Value extends (arg: infer Arg) => unknown
      ? Arg
      : true extends Value
        ? Key extends CSSPropertiesKeys
          ? CSSProperties[Key]
          : never
        : false extends Value
          ? never
          : Value extends Record<infer StyleObjectKey, unknown>
            ? StyleObjectKey
            : never;

type ShortcutsInput<
  Properties extends Record<string, unknown>,
  Shortcuts extends Record<string, unknown>,
  Conditions extends DefineRulesConditions
> = {
  [Key in keyof Shortcuts]?: ResolveConditionableValue<
    ResolveShortcutValue<Properties, Shortcuts, Conditions, Shortcuts[Key]>,
    Conditions
  >;
};

type ResolveShortcutValue<
  Properties extends Record<string, unknown>,
  Shortcuts extends Record<string, unknown>,
  Conditions extends DefineRulesConditions,
  Value
> = Value extends readonly unknown[]
  ? ResolveShortcutArrayRef<Properties, Shortcuts, Conditions, Value>
  : Value extends (arg: infer Arg) => unknown
    ? Arg
    : Value extends Record<string, unknown>
      ? boolean
      : ResolveShortcutRef<Properties, Shortcuts, Conditions, Value>;

type ResolveShortcutArrayRef<
  Properties extends Record<string, unknown>,
  Shortcuts extends Record<string, unknown>,
  Conditions extends DefineRulesConditions,
  Targets extends readonly unknown[]
> = Targets extends readonly [infer H, ...infer R]
  ? ResolveShortcutRef<Properties, Shortcuts, Conditions, H> &
      ResolveShortcutArrayRef<Properties, Shortcuts, Conditions, R>
  : unknown;

type ResolveShortcutRef<
  Properties extends Record<string, unknown>,
  Shortcuts extends Record<string, unknown>,
  Conditions extends DefineRulesConditions,
  Ref
> = [Ref] extends [keyof Properties]
  ? Properties[Ref]
  : [Ref] extends [keyof Shortcuts]
    ? ShortcutsInput<Properties, Shortcuts, Conditions>[Ref]
    : never;

type DefineRulesNestedConditionInput<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions
> = keyof Conditions extends never
  ? DefineRulesEmptyConditions
  : {
      [Alias in DefineRulesConditionAliasKey<Conditions>]?: DefineRulesNestedCssInput<
        Properties,
        Shortcuts,
        Conditions
      >;
    };

type DefineRulesNestedCssInput<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions
> = DefineRulesCssInput<Properties, Shortcuts, Conditions> &
  DefineRulesTransformNestedInput;

type DefineRulesTransformNestedInput = Record<string, unknown>;

export type DefineRulesCssInput<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions = DefineRulesEmptyConditions
> = PropertiesInput<Properties, Conditions> &
  ShortcutsInput<
    PropertiesInput<Properties, Conditions>,
    Shortcuts,
    Conditions
  > &
  DefineRulesNestedConditionInput<Properties, Shortcuts, Conditions>;

export type DefineRulesInlineCssInput<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions = DefineRulesEmptyConditions,
  CssInput = DefineRulesCssInput<Properties, Shortcuts, Conditions>
> = keyof {
  [Key in keyof CssInput as boolean extends CssInput[Key]
    ? Key
    : never]: CssInput[Key];
};

export type DefineRulesComplexCssInput<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions = DefineRulesEmptyConditions
> =
  | DefineRulesCssInput<Properties, Shortcuts, Conditions>
  | DefineRulesInlineCssInput<Properties, Shortcuts, Conditions>
  | Array<
      | DefineRulesCssInput<Properties, Shortcuts, Conditions>
      | DefineRulesInlineCssInput<Properties, Shortcuts, Conditions>
    >;

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, assertType } = import.meta.vitest;

  describe.concurrent("DefineRules Type Test", () => {
    function createDefineRulesTypeCase<
      const Properties extends DefineRulesProperties,
      const Shortcuts extends DefineRulesShortcuts<
        Properties,
        Shortcuts,
        Conditions
      >,
      const Conditions extends DefineRulesConditions =
        DefineRulesEmptyConditions
    >(defineRulesCtx: DefineRulesCtx<Properties, Shortcuts, Conditions>) {
      return {
        defineRulesCtx,
        _cssInput: defineRulesCtx as unknown as DefineRulesComplexCssInput<
          Properties,
          Shortcuts,
          Conditions
        >
      };
    }

    describe.concurrent("DefineRulesProperties Type", () => {
      it("Array values for CSS properties", () => {
        const { defineRulesCtx, _cssInput } = createDefineRulesTypeCase({
          properties: {
            display: ["none", "inline", "block"],
            paddingLeft: [0, 2, 4, 8, 16, 32, 64]
          }
        });
        assertType<{
          properties?: {
            readonly display: readonly ["none", "inline", "block"];
            readonly paddingLeft: readonly [0, 2, 4, 8, 16, 32, 64];
          };
        }>(defineRulesCtx);

        assertType<typeof _cssInput>({
          display: "inline",
          paddingLeft: 4
        });
        assertType<typeof _cssInput>({
          // @ts-expect-error: invalid value
          display: "flex",
          // @ts-expect-error: invalid value
          paddingLeft: 5
        });
      });

      it("Object values for CSS properties", () => {
        const { defineRulesCtx, _cssInput } = createDefineRulesTypeCase({
          properties: {
            color: {
              "indigo-800": "rgb(55, 48, 163)",
              "red-500": "rgb(239, 68, 68)"
            }
          }
        });
        assertType<{
          properties?: {
            color: {
              "indigo-800": string;
              "red-500": string;
            };
          };
        }>(defineRulesCtx);

        assertType<typeof _cssInput>({
          color: "indigo-800"
        });
        assertType<typeof _cssInput>({
          // @ts-expect-error: invalid value
          color: "blue-500"
        });
      });

      it("Object values with CSSPropertiesWithVars", () => {
        const alpha = "--alpha";
        const { defineRulesCtx, _cssInput } = createDefineRulesTypeCase({
          properties: {
            background: {
              red: {
                vars: { [alpha]: "1" },
                background: `rgba(255, 0, 0, var(${alpha}))`
              }
            }
          }
        });
        assertType<{
          properties?: {
            background: {
              red: {
                vars: { "--alpha": string };
                background: string;
              };
            };
          };
        }>(defineRulesCtx);

        assertType<typeof _cssInput>({
          background: "red"
        });
        assertType<typeof _cssInput>({
          // @ts-expect-error: invalid value
          background: "blue"
        });
      });

      it("Boolean values for entire properties", () => {
        const { defineRulesCtx, _cssInput } = createDefineRulesTypeCase({
          properties: {
            border: false,
            margin: true
          }
        });
        assertType<{
          properties?: {
            border: false;
            margin: true;
          };
        }>(defineRulesCtx);

        assertType<typeof _cssInput>({
          margin: "inherit"
        });
        // @ts-expect-error: `border` is false, so it should not accept any value.
        assertType<typeof _cssInput>({
          border: "1px solid black"
        });
      });

      it("Custom properties with CSSPropertiesWithVars", () => {
        const alpha = "--alpha";
        const { defineRulesCtx, _cssInput } = createDefineRulesTypeCase({
          properties: {
            backgroundOpacity: {
              full: { vars: { [alpha]: "1" } },
              half: { vars: { [alpha]: "0.5" } }
            }
          }
        });
        assertType<{
          properties?: {
            backgroundOpacity: {
              full: { vars: { "--alpha": string } };
              half: { vars: { "--alpha": string } };
            };
          };
        }>(defineRulesCtx);

        assertType<typeof _cssInput>({
          backgroundOpacity: "full"
        });
        assertType<typeof _cssInput>({
          // @ts-expect-error: invalid value
          backgroundOpacity: "quarter"
        });
      });

      it("Function values return CSS properties", () => {
        const { defineRulesCtx, _cssInput } = createDefineRulesTypeCase({
          properties: {
            color(arg: "primary" | "secondary") {
              if (arg === "primary") {
                return { color: "blue" } as const;
              } else {
                return { color: "gray" } as const;
              }
            }
          }
        });
        assertType<{
          properties?: {
            color: (arg: "primary" | "secondary") =>
              | {
                  color: string;
                }
              | undefined;
          };
        }>(defineRulesCtx);

        assertType<typeof _cssInput>({
          color: "primary"
        });
      });

      it("Function values return Style objects", () => {
        const { defineRulesCtx, _cssInput } = createDefineRulesTypeCase({
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
        assertType<{
          properties?: {
            color: (arg: "primary" | "secondary") => "blue" | "gray";
            otherColor: (arg: "primary" | "secondary") =>
              | {
                  color: string;
                }
              | undefined;
          };
        }>(defineRulesCtx);

        assertType<typeof _cssInput>({
          color: "primary"
        });
      });
    });

    describe.concurrent("DefineRulesPresetInput Type", () => {
      it("Accepts artifact-safe v4 metadata helper types", () => {
        const knownEntry: DefineRulesPresetCompiledKnownEntry = {
          kind: "known",
          className: "color_red",
          writeKeyId: 0
        };
        const unknownEntry: DefineRulesPresetCompiledUnknownEntry = {
          kind: "unknown",
          className: "external"
        };
        const segment: DefineRulesPresetCompiledSegment = {
          entries: [knownEntry, unknownEntry],
          hasKnownAtomicClass: true
        };
        const writeKey: DefineRulesPresetWriteKey = {
          conditionId: 0,
          propertyId: 0
        };
        const artifact: DefineRulesPresetArtifactV4 = {
          schema: "mincho.defineRulesPreset",
          version: 4,
          classNameByCache: {
            colorRed: "color_red"
          },
          writeKeyByCacheKey: {
            colorRed: 0
          },
          conditionById: {
            0: {
              layer: null,
              supports: null,
              media: null,
              container: null,
              selector: "&"
            }
          },
          propertyById: {
            0: "color"
          },
          writeKeyById: {
            0: writeKey
          }
        };

        assertType<DefineRulesPresetCompiledEntry>(knownEntry);
        assertType<DefineRulesPresetCompiledEntry>(unknownEntry);
        assertType<DefineRulesPresetCompiledSegment>(segment);
        assertType<DefineRulesPresetArtifactV4>(artifact);

        const { defineRulesCtx } = createDefineRulesTypeCase({
          presets: [artifact, [artifact]],
          properties: {
            color: true
          }
        });

        assertType<DefineRulesPresetInput | undefined>(defineRulesCtx.presets);
      });

      it("Rejects preset owner objects", () => {
        const owner = {
          css: (_args: unknown) => "className",
          preset: {
            colorRed: "color_red"
          }
        };

        createDefineRulesTypeCase({
          properties: {
            color: true
          },
          // @ts-expect-error: presets accepts v4 artifacts or arrays only.
          presets: owner
        });
      });
    });

    describe.concurrent("DefineRulesConditions Type", () => {
      it("accepts configured condition aliases in nested and property-level inputs", () => {
        const { defineRulesCtx: _defineRulesCtx, _cssInput } =
          createDefineRulesTypeCase({
            conditions: {
              mobile: {},
              tablet: "@media screen and (min-width: 768px)",
              desktop: {
                "@media": "screen and (min-width: 1024px)"
              },
              interactive: {
                selector: "&:hover",
                "@supports": "(display: grid)"
              }
            },
            properties: {
              color: true,
              display: ["none", "flex"],
              fontSize: true
            },
            shortcuts: {
              inline: {
                display: "flex",
                _tablet: {
                  color: "blue"
                }
              }
            }
          });

        assertType<"_mobile" | "_tablet" | "_desktop" | "_interactive">(
          "" as DefineRulesConditionAliasKey<
            NonNullable<typeof _defineRulesCtx.conditions>
          >
        );
        assertType<typeof _cssInput>({
          _mobile: {
            color: "red",
            _tablet: {
              display: "flex"
            },
            "nav li > &": {
              "@supports": {
                "(display: grid)": {
                  _hover: {
                    fontSize: 12
                  }
                }
              }
            }
          },
          _desktop: {
            display: "flex"
          },
          color: {
            base: "black",
            _tablet: "blue",
            _interactive: {
              _mobile: "green"
            }
          },
          inline: true
        });
      });

      it("rejects unconfigured condition aliases in nested and property-level inputs", () => {
        const { _cssInput } = createDefineRulesTypeCase({
          conditions: {
            mobile: {}
          },
          properties: {
            color: true
          }
        });

        assertType<typeof _cssInput>({
          // @ts-expect-error: _desktop is not configured.
          _desktop: {
            color: "red"
          }
        });
        assertType<typeof _cssInput>({
          color: {
            base: "red",
            _mobile: "blue"
          }
        });
        assertType<typeof _cssInput>({
          color: {
            base: "red",
            _mobile: {
              _mobile: "blue"
            }
          }
        });
      });

      it("rejects arbitrary nested condition config objects", () => {
        createDefineRulesTypeCase({
          conditions: {
            mobile: {
              // @ts-expect-error: condition config objects only support known condition keys.
              nested: {
                "@media": "screen and (min-width: 768px)"
              }
            }
          },
          properties: {
            color: true
          }
        });
      });
    });

    describe.concurrent("DefineRulesShortcuts Type", () => {
      it("Single property shortcut", () => {
        const { defineRulesCtx, _cssInput } = createDefineRulesTypeCase({
          properties: {
            paddingLeft: [0, 4, 8],
            paddingRight: [0, 4, 8]
          },
          shortcuts: {
            pl: "paddingLeft",
            pr: "paddingRight"
          }
        });
        assertType<{
          properties?: {
            paddingLeft: readonly [0, 4, 8];
            paddingRight: readonly [0, 4, 8];
          };
          shortcuts?: {
            pl: "paddingLeft";
            pr: "paddingRight";
          };
        }>(defineRulesCtx);

        assertType<typeof _cssInput>({
          pl: 4,
          pr: 8
        });
        assertType<typeof _cssInput>({
          // @ts-expect-error: invalid value
          pl: 5,
          // @ts-expect-error: invalid value
          pr: 9
        });
      });

      it("Array shortcut referencing properties", () => {
        const { defineRulesCtx, _cssInput } = createDefineRulesTypeCase({
          properties: {
            paddingLeft: [0, 4, 8],
            paddingRight: [0, 4, 8, 12]
          },
          shortcuts: {
            px: ["paddingLeft", "paddingRight"]
          }
        });
        assertType<{
          properties?: {
            paddingLeft: readonly [0, 4, 8];
            paddingRight: readonly [0, 4, 8, 12];
          };
          shortcuts?: {
            px: readonly ["paddingLeft", "paddingRight"];
          };
        }>(defineRulesCtx);

        assertType<typeof _cssInput>({
          px: 4
        });
        assertType<typeof _cssInput>({
          // @ts-expect-error: invalid value
          px: 5
        });
        assertType<typeof _cssInput>({
          // @ts-expect-error: invalid value
          px: 12
        });
      });

      it("Shortcut referencing other shortcuts", () => {
        const { defineRulesCtx, _cssInput } = createDefineRulesTypeCase({
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
        assertType<{
          properties?: {
            paddingLeft: readonly [0, 4, 8];
            paddingRight: readonly [0, 4, 8, 12];
          };
          shortcuts?: {
            pl: "paddingLeft";
            pr: "paddingRight";
            px: readonly ["pl", "pr"];
          };
        }>(defineRulesCtx);

        assertType<typeof _cssInput>({
          px: 4
        });
        assertType<typeof _cssInput>({
          // @ts-expect-error: invalid value
          px: 5
        });
        assertType<typeof _cssInput>({
          // @ts-expect-error: invalid value
          px: 12
        });
      });

      it("Mixed shortcuts with properties and other shortcuts", () => {
        const { defineRulesCtx } = createDefineRulesTypeCase({
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
        assertType<{
          properties?: {
            paddingTop: readonly [0, 4, 8];
            paddingBottom: readonly [0, 4, 8];
            paddingLeft: readonly [0, 4, 8];
            paddingRight: readonly [0, 4, 8];
          };
          shortcuts?: {
            pt: "paddingTop";
            pb: "paddingBottom";
            pl: "paddingLeft";
            pr: "paddingRight";
            py: readonly ["pt", "pb"];
            px: readonly ["pl", "pr"];
            p: readonly ["py", "px"];
          };
        }>(defineRulesCtx);
      });

      it("Fixed object shortcut", () => {
        const { defineRulesCtx, _cssInput } = createDefineRulesTypeCase({
          properties: {
            display: ["none", "inline", "block"]
          },
          shortcuts: {
            inline: { display: "inline" }
          }
        });
        assertType<{
          properties?: {
            display: readonly ["none", "inline", "block"];
          };
          shortcuts?: {
            inline: { readonly display: "inline" };
          };
        }>(defineRulesCtx);

        assertType<typeof _cssInput>({
          inline: true
        });
        assertType<typeof _cssInput>(["inline"]);
      });

      it("Function shortcut", () => {
        const { defineRulesCtx, _cssInput } = createDefineRulesTypeCase({
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
        assertType<{
          properties?: {
            display: readonly ["none", "inline", "block"];
            paddingLeft: readonly [0, 4, 8];
            paddingRight: readonly [0, 4, 8];
          };
          shortcuts?: {
            px: readonly ["paddingLeft", "paddingRight"];
            center: (arg: "none" | "inline" | "block") =>
              | {
                  display: "none" | "inline" | "block";
                  px: number;
                }
              | undefined;
          };
        }>(defineRulesCtx);

        assertType<typeof _cssInput>({
          center: "inline"
        });
        assertType<typeof _cssInput>({
          // @ts-expect-error: invalid value
          center: "flex"
        });
      });

      it("Function shortcut returns nested style objects", () => {
        const { _cssInput } = createDefineRulesTypeCase({
          properties: {
            display: ["none", "inline", "block"],
            paddingLeft: [0, 4, 8],
            paddingRight: [0, 4, 8]
          },
          shortcuts: {
            px: ["paddingLeft", "paddingRight"],
            responsiveCenter(arg: "none" | "inline" | "block") {
              return {
                "@media": {
                  "screen and (min-width: 768px)": {
                    display: arg,
                    px: 4
                  }
                },
                "&:hover": {
                  display: "block",
                  px: 8
                }
              } as const;
            }
          }
        });

        assertType<typeof _cssInput>({
          responsiveCenter: "inline"
        });
        assertType<typeof _cssInput>({
          // @ts-expect-error: invalid value
          responsiveCenter: "flex"
        });
      });
    });

    describe.concurrent("Invalid Type Cases", () => {
      it("Invalid shortcut reference should error", () => {
        createDefineRulesTypeCase({
          properties: {
            paddingLeft: [0, 4, 8]
          },
          shortcuts: {
            // @ts-expect-error: 'nonExistent' is not a valid property or shortcut
            pl: "nonExistent"
          }
        });
      });

      it("Shortcut cannot reference itself", () => {
        createDefineRulesTypeCase({
          properties: {
            paddingLeft: [0, 4, 8]
          },
          shortcuts: {
            // @ts-expect-error: shortcut cannot reference itself
            pl: "pl"
          }
        });
      });

      it("Array shortcut with invalid reference should error", () => {
        createDefineRulesTypeCase({
          properties: {
            paddingLeft: [0, 4, 8],
            paddingRight: [0, 4, 8]
          },
          shortcuts: {
            // @ts-expect-error: 'invalid' is not a valid property or shortcut
            px: ["paddingLeft", "invalid"]
          }
        });
      });
    });

    describe.concurrent("Complex DefineRules", () => {
      it("Full featured defineRules", () => {
        const alpha = "--alpha";
        const { defineRulesCtx } = createDefineRulesTypeCase({
          properties: {
            // Array values
            display: ["none", "inline", "block", "flex", "grid"],
            paddingLeft: [0, 2, 4, 8, 16, 32, 64],
            paddingRight: [0, 2, 4, 8, 16, 32, 64],
            paddingTop: [0, 2, 4, 8, 16, 32, 64],
            paddingBottom: [0, 2, 4, 8, 16, 32, 64],

            // Object values
            color: {
              "indigo-800": "rgb(55, 48, 163)",
              "red-500": "rgb(239, 68, 68)",
              "blue-500": "rgb(59, 130, 246)"
            },

            // CSSPropertiesWithVars
            background: {
              red: {
                vars: { [alpha]: "1" },
                background: `rgba(255, 0, 0, var(${alpha}))`
              },
              blue: {
                vars: { [alpha]: "1" },
                background: `rgba(0, 0, 255, var(${alpha}))`
              }
            },

            // Custom properties
            backgroundOpacity: {
              full: { vars: { [alpha]: "1" } },
              half: { vars: { [alpha]: "0.5" } },
              quarter: { vars: { [alpha]: "0.25" } }
            },

            // Boolean
            border: false
          },
          shortcuts: {
            // Single property shortcuts
            pl: "paddingLeft",
            pr: "paddingRight",
            pt: "paddingTop",
            pb: "paddingBottom",

            // Multiple property shortcuts
            px: ["pl", "pr"],
            py: ["pt", "pb"],
            p: ["px", "py"],

            // Fixed object shortcut
            inline: { display: "inline" }
          }
        });

        assertType<{
          properties?: {
            display: readonly ["none", "inline", "block", "flex", "grid"];
            paddingLeft: readonly [0, 2, 4, 8, 16, 32, 64];
            paddingRight: readonly [0, 2, 4, 8, 16, 32, 64];
            paddingTop: readonly [0, 2, 4, 8, 16, 32, 64];
            paddingBottom: readonly [0, 2, 4, 8, 16, 32, 64];
            color: {
              "indigo-800": string;
              "red-500": string;
              "blue-500": string;
            };
            background: {
              red: {
                vars: { "--alpha": string };
                background: string;
              };
              blue: {
                vars: { "--alpha": string };
                background: string;
              };
            };
            backgroundOpacity: {
              full: { vars: { "--alpha": string } };
              half: { vars: { "--alpha": string } };
              quarter: { vars: { "--alpha": string } };
            };
            border: false;
          };
          shortcuts?: {
            pl: "paddingLeft";
            pr: "paddingRight";
            pt: "paddingTop";
            pb: "paddingBottom";
            px: readonly ["pl", "pr"];
            py: readonly ["pt", "pb"];
            p: readonly ["px", "py"];
            inline: { readonly display: "inline" };
          };
        }>(defineRulesCtx);
      });
    });
  });
}
