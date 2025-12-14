import type {
  NonNullableString,
  CSSProperties,
  CSSPropertiesWithVars
} from "@mincho-js/transform-to-vanilla";

type DefineRulesCssProperties = {
  [Property in keyof CSSProperties]?:
    | ReadonlyArray<CSSProperties[Property]>
    | Record<string, CSSProperties[Property] | CSSPropertiesWithVars>
    | true
    | false;
};
type DefineRulesCustomProperties = Partial<
  Record<
    Exclude<NonNullableString, keyof CSSProperties>,
    Record<string, CSSPropertiesWithVars>
  >
>;
type DefineRulesProperties =
  | DefineRulesCssProperties
  | DefineRulesCustomProperties;

type ShortcutValue<
  Properties extends DefineRulesProperties,
  Shortcuts,
  ShortcutsKey extends keyof Shortcuts
> =
  | keyof Properties
  | Exclude<keyof Shortcuts, ShortcutsKey>
  | ReadonlyArray<keyof Properties | Exclude<keyof Shortcuts, ShortcutsKey>>;

type DefineRulesShortcuts<
  Properties extends DefineRulesProperties,
  Shortcuts
> = {
  [ShortcutsKey in keyof Shortcuts]: ShortcutValue<
    Properties,
    Shortcuts,
    ShortcutsKey
  >;
};

interface DefineRulesInput<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
> {
  properties?: Properties;
  shortcuts?: Shortcuts;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, assertType } = import.meta.vitest;

  describe.concurrent("DefineRules Type Test", () => {
    function defineRules<
      const Properties extends DefineRulesProperties,
      const Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
    >(rules: DefineRulesInput<Properties, Shortcuts>) {
      return rules;
    }

    describe.concurrent("DefineRulesProperties Type", () => {
      it("Array values for CSS properties", () => {
        const rules = defineRules({
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
      });

      it("Object values for CSS properties", () => {
        const rules = defineRules({
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
      });

      it("Object values with CSSPropertiesWithVars", () => {
        const alpha = "--alpha";
        const rules = defineRules({
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
      });

      it("Boolean values for entire properties", () => {
        const rules = defineRules({
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
      });

      it("Custom properties with CSSPropertiesWithVars", () => {
        const alpha = "--alpha";
        const rules = defineRules({
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
      });
    });

    describe.concurrent("DefineRulesShortcuts Type", () => {
      it("Single property shortcut", () => {
        const rules = defineRules({
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
      });

      it("Array shortcut referencing properties", () => {
        const rules = defineRules({
          properties: {
            paddingLeft: [0, 4, 8],
            paddingRight: [0, 4, 8]
          },
          shortcuts: {
            px: ["paddingLeft", "paddingRight"]
          }
        });
        assertType<{
          properties?: {
            paddingLeft: readonly [0, 4, 8];
            paddingRight: readonly [0, 4, 8];
          };
          shortcuts?: {
            px: readonly ["paddingLeft", "paddingRight"];
          };
        }>(rules);
      });

      it("Shortcut referencing other shortcuts", () => {
        const rules = defineRules({
          properties: {
            paddingLeft: [0, 4, 8],
            paddingRight: [0, 4, 8]
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
            paddingRight: readonly [0, 4, 8];
          };
          shortcuts?: {
            pl: "paddingLeft";
            pr: "paddingRight";
            px: readonly ["pl", "pr"];
          };
        }>(rules);
      });

      it("Mixed shortcuts with properties and other shortcuts", () => {
        const rules = defineRules({
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
    });

    describe.concurrent("Invalid Type Cases", () => {
      it("Invalid shortcut reference should error", () => {
        defineRules({
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
        defineRules({
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
        defineRules({
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
        const rules = defineRules({
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
            pl: "paddingLeft",
            pr: "paddingRight",
            pt: "paddingTop",
            pb: "paddingBottom",
            px: ["pl", "pr"],
            py: ["pt", "pb"],
            p: ["px", "py"]
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
          };
        }>(rules);
      });
    });
  });
}
