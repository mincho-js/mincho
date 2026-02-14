import type { CSSProperties } from "@mincho-js/transform-to-vanilla";
import type {
  DefineRulesComplexCssInput,
  DefineRulesCtx,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./types.js";

// == Define Rules =============================================================
export function defineRules<
  const Properties extends DefineRulesProperties,
  const Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(config: DefineRulesCtx<Properties, Shortcuts>) {
  type DefineProperties = DefineRulesComplexCssInput<Properties, Shortcuts>;
  function cssRaw(args: DefineProperties): CSSProperties {
    const out: CSSProperties = {};
    applyInput(config, out, args, []);
    return out;
  }

  const css = Object.assign({}, { raw: cssRaw });
  return { css };
}

// == Define Rules Impl ========================================================
function applyInput<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  out: CSSProperties,
  input: unknown,
  stack: string[]
) {
  if (input == null || input === false) return;

  if (typeof input === "string") {
    applyFixedStyle(ctx, out, input, stack);
    return;
  }

  if (Array.isArray(input)) {
    applyArray(ctx, out, input, stack);
    return;
  }

  if (isPlainObject(input)) {
    applyObject(ctx, out, input, stack);
    return;
  }

  throw new Error(`Unsupported css() argument: ${String(input)}`);
}

function applyFixedStyle<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  out: CSSProperties,
  inlineStyle: string,
  stack: string[]
) {
  if (hasOwn(ctx.shortcuts, inlineStyle)) {
    applyShortcut(ctx, out, inlineStyle, undefined, stack);
    return;
  }
  throw new Error(`Unknown fixed style: "${inlineStyle}"`);
}

function applyArray<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  out: CSSProperties,
  arr: readonly unknown[],
  stack: string[]
) {
  for (const item of arr) {
    applyInput(ctx, out, item, stack);
  }
}

function applyObject<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  out: CSSProperties,
  obj: Record<string, unknown>,
  stack: string[]
) {
  for (const [k, v] of Object.entries(obj)) {
    applyEntry(ctx, out, k, v, stack);
  }
}

function applyEntry<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  out: CSSProperties,
  key: string,
  value: unknown,
  stack: string[]
) {
  if (hasOwn(ctx.shortcuts, key)) {
    applyShortcut(ctx, out, key, value, stack);
    return;
  }

  applyProperty(ctx, out, key, value);
}

function applyProperty<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  out: CSSProperties,
  prop: string,
  value: unknown
) {
  const propDef = ctx.properties?.[prop as keyof Properties];

  if (typeof propDef === "function") {
    const result = propDef(value);
    if (isPlainObject(result)) {
      Object.assign(out, result);
      return;
    } else {
      (out as Record<string, unknown>)[prop] = result;
      return;
    }
  }

  // just assign => last one wins
  if (isPlainObject(propDef) === false) {
    (out as Record<string, unknown>)[prop] = value;
    return;
  }

  const mapped = propDef[value as string];

  // Style object value => assign all
  if (isPlainObject(mapped)) {
    Object.assign(out, mapped);
    return;
  }

  // Mapped value => assign mapped value
  (out as Record<string, unknown>)[prop] = mapped ?? value;
}

function applyShortcut<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  out: CSSProperties,
  name: string,
  value: unknown,
  stack: string[]
) {
  if (stack.includes(name)) {
    throw new Error(
      `Circular shortcut reference: ${[...stack, name].join(" -> ")}`
    );
  }

  const def = ctx.shortcuts?.[name as keyof Shortcuts];
  if (def == null) return;

  const nextStack = stack.concat(name);

  if (typeof def === "string") {
    // single alias: pl -> paddingLeft
    applyEntry(ctx, out, def, value, nextStack);
    return;
  }

  if (Array.isArray(def)) {
    // multi alias: px -> [pl, pr]
    for (const alias of def) {
      applyEntry(ctx, out, alias, value, nextStack);
    }
    return;
  }

  if (typeof def === "function") {
    // fn shortcut
    const produced = def(value);
    applyInput(ctx, out, produced, nextStack);
    return;
  }

  if (isPlainObject(def)) {
    // fixed style shortcut
    // - "inline" token (no value) => apply
    // - { inline: true } => apply
    // - { inline: false } => do not apply
    if (value === undefined || value === true) {
      applyInput(ctx, out, def, nextStack);
      return;
    }
    if (!value) return;
    applyInput(ctx, out, def, nextStack);
    return;
  }

  throw new Error(`Unsupported shortcut definition for "${name}"`);
}

// == Utils ====================================================================
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function hasOwn(obj: object | undefined, key: PropertyKey): boolean {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  describe("defineRules", () => {
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

      it("Last one wins for properties", () => {
        const { css } = defineRules({
          properties: {
            color: true
          }
        });

        expect(css.raw([{ color: "red" }, { color: "blue" }])).toEqual({
          color: "blue"
        });
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
      });
    });
  });
}
