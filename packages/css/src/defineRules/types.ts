import type {
  NonNullableString,
  CSSProperties,
  CSSPropertiesWithVars
} from "@mincho-js/transform-to-vanilla";

type CSSPropertiesKeys = keyof CSSProperties;

type DefineRulesResolver<
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
  | DefineRulesResolver<Value>
  | true
  | false;

type DefineRulesCustomProperties = Partial<
  Record<
    Exclude<NonNullableString, CSSPropertiesKeys>,
    Record<string, CSSPropertiesWithVars> | DefineRulesResolver
  >
>;
export type DefineRulesProperties =
  | DefineRulesCssProperties
  | DefineRulesCustomProperties;

type ShortcutValue<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>,
  ShortcutsKey extends keyof Shortcuts
> =
  | keyof Properties
  | Exclude<keyof Shortcuts, ShortcutsKey>
  | ReadonlyArray<keyof Properties | Exclude<keyof Shortcuts, ShortcutsKey>>
  | DefineRulesCssInput<Properties, Shortcuts>
  | DefineRulesResolver<DefineRulesCssInput<Properties, Shortcuts>>;

export type DefineRulesShortcuts<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
> = {
  [ShortcutsKey in keyof Shortcuts]: ShortcutValue<
    Properties,
    Shortcuts,
    ShortcutsKey
  >;
};

export interface DefineRulesCtx<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
> {
  properties?: Properties;
  shortcuts?: Shortcuts;
}

type PropertiesInput<Properties extends DefineRulesProperties> = {
  [Key in keyof Properties]?: ResolvePropertiesValue<Key, Properties[Key]>;
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
  Shortcuts extends Record<string, unknown>
> = {
  [Key in keyof Shortcuts]?: ResolveShortcutValue<
    Properties,
    Shortcuts,
    Shortcuts[Key]
  >;
};

type ResolveShortcutValue<
  Properties extends Record<string, unknown>,
  Shortcuts extends Record<string, unknown>,
  Value
> = Value extends readonly unknown[]
  ? ResolveShortcutArrayRef<Properties, Shortcuts, Value>
  : Value extends (arg: infer Arg) => unknown
    ? Arg
    : Value extends Record<string, unknown>
      ? boolean
      : ResolveShortcutRef<Properties, Shortcuts, Value>;

type ResolveShortcutArrayRef<
  Properties extends Record<string, unknown>,
  Shortcuts extends Record<string, unknown>,
  Targets extends readonly unknown[]
> = Targets extends readonly [infer H, ...infer R]
  ? ResolveShortcutRef<Properties, Shortcuts, H> &
      ResolveShortcutArrayRef<Properties, Shortcuts, R>
  : unknown;

type ResolveShortcutRef<
  Properties extends Record<string, unknown>,
  Shortcuts extends Record<string, unknown>,
  Ref
> = [Ref] extends [keyof Properties]
  ? Properties[Ref]
  : [Ref] extends [keyof Shortcuts]
    ? ShortcutsInput<Properties, Shortcuts>[Ref]
    : never;

export type DefineRulesCssInput<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
> = PropertiesInput<Properties> &
  ShortcutsInput<PropertiesInput<Properties>, Shortcuts>;

export type DefineRulesInlineCssInput<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>,
  CssInput = DefineRulesCssInput<Properties, Shortcuts>
> = keyof {
  [Key in keyof CssInput as boolean extends CssInput[Key]
    ? Key
    : never]: CssInput[Key];
};

export type DefineRulesComplexCssInput<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
> =
  | DefineRulesCssInput<Properties, Shortcuts>
  | DefineRulesInlineCssInput<Properties, Shortcuts>
  | Array<
      | DefineRulesCssInput<Properties, Shortcuts>
      | DefineRulesInlineCssInput<Properties, Shortcuts>
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
    function resolveDefineRules<
      const Properties extends DefineRulesProperties,
      const Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
    >(rules: DefineRulesCtx<Properties, Shortcuts>) {
      return {
        rules,
        _props: rules as unknown as DefineRulesComplexCssInput<
          Properties,
          Shortcuts
        >
      };
    }

    describe.concurrent("DefineRulesProperties Type", () => {
      it("Array values for CSS properties", () => {
        const { rules, _props } = resolveDefineRules({
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
        }>(rules);

        assertType<typeof _props>({
          display: "inline",
          paddingLeft: 4
        });
        assertType<typeof _props>({
          // @ts-expect-error: invalid value
          display: "flex",
          // @ts-expect-error: invalid value
          paddingLeft: 5
        });
      });

      it("Object values for CSS properties", () => {
        const { rules, _props } = resolveDefineRules({
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
        }>(rules);

        assertType<typeof _props>({
          color: "indigo-800"
        });
        assertType<typeof _props>({
          // @ts-expect-error: invalid value
          color: "blue-500"
        });
      });

      it("Object values with CSSPropertiesWithVars", () => {
        const alpha = "--alpha";
        const { rules, _props } = resolveDefineRules({
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
        }>(rules);

        assertType<typeof _props>({
          background: "red"
        });
        assertType<typeof _props>({
          // @ts-expect-error: invalid value
          background: "blue"
        });
      });

      it("Boolean values for entire properties", () => {
        const { rules, _props } = resolveDefineRules({
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
        }>(rules);

        assertType<typeof _props>({
          margin: "inherit"
        });
        // @ts-expect-error: `border` is false, so it should not accept any value.
        assertType<typeof _props>({
          border: "1px solid black"
        });
      });

      it("Custom properties with CSSPropertiesWithVars", () => {
        const alpha = "--alpha";
        const { rules, _props } = resolveDefineRules({
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
        }>(rules);

        assertType<typeof _props>({
          backgroundOpacity: "full"
        });
        assertType<typeof _props>({
          // @ts-expect-error: invalid value
          backgroundOpacity: "quarter"
        });
      });

      it("Function values return CSS properties", () => {
        const { rules, _props } = resolveDefineRules({
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
        }>(rules);

        assertType<typeof _props>({
          color: "primary"
        });
      });

      it("Function values return Style objects", () => {
        const { rules, _props } = resolveDefineRules({
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
        }>(rules);

        assertType<typeof _props>({
          color: "primary"
        });
      });
    });

    describe.concurrent("DefineRulesShortcuts Type", () => {
      it("Single property shortcut", () => {
        const { rules, _props } = resolveDefineRules({
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
        }>(rules);

        assertType<typeof _props>({
          pl: 4,
          pr: 8
        });
        assertType<typeof _props>({
          // @ts-expect-error: invalid value
          pl: 5,
          // @ts-expect-error: invalid value
          pr: 9
        });
      });

      it("Array shortcut referencing properties", () => {
        const { rules, _props } = resolveDefineRules({
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
        }>(rules);

        assertType<typeof _props>({
          px: 4
        });
        assertType<typeof _props>({
          // @ts-expect-error: invalid value
          px: 5
        });
        assertType<typeof _props>({
          // @ts-expect-error: invalid value
          px: 12
        });
      });

      it("Shortcut referencing other shortcuts", () => {
        const { rules, _props } = resolveDefineRules({
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
        }>(rules);

        assertType<typeof _props>({
          px: 4
        });
        assertType<typeof _props>({
          // @ts-expect-error: invalid value
          px: 5
        });
        assertType<typeof _props>({
          // @ts-expect-error: invalid value
          px: 12
        });
      });

      it("Mixed shortcuts with properties and other shortcuts", () => {
        const { rules } = resolveDefineRules({
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
        }>(rules);
      });

      it("Fixed object shortcut", () => {
        const { rules, _props } = resolveDefineRules({
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
        }>(rules);

        assertType<typeof _props>({
          inline: true
        });
        assertType<typeof _props>(["inline"]);
      });

      it("Function shortcut", () => {
        const { rules, _props } = resolveDefineRules({
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
        }>(rules);

        assertType<typeof _props>({
          center: "inline"
        });
        assertType<typeof _props>({
          // @ts-expect-error: invalid value
          center: "flex"
        });
      });
    });

    describe.concurrent("Invalid Type Cases", () => {
      it("Invalid shortcut reference should error", () => {
        resolveDefineRules({
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
        resolveDefineRules({
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
        resolveDefineRules({
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
        const { rules } = resolveDefineRules({
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
        }>(rules);
      });
    });
  });
}
