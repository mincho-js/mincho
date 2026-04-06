import type { CSSProperties } from "@mincho-js/transform-to-vanilla";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import { createCanonicalStyleCache } from "./utils.js";
import { identifierName } from "../utils.js";
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
  type CssInput = DefineRulesComplexCssInput<Properties, Shortcuts>;
  const styleCache = createCanonicalStyleCache(config.debugId);

  function resolveToFragments(args: CssInput): ResolvedStyleFragment[] {
    const fragments: ResolvedStyleFragment[] = [];
    applyInput(config, fragments, args, []);
    return fragments;
  }

  function cssRaw(args: CssInput): CSSProperties {
    return flattenResolvedFragments(resolveToFragments(args));
  }

  function cssImpl(args: CssInput): string {
    const fragments = resolveToFragments(args);
    const emittedFragments = collectEmittedFragments(fragments);
    const output: string[] = [];

    for (const fragment of emittedFragments) {
      const className = styleCache.addFragment(
        fragment.inputIdentity.property,
        fragment.inputIdentity.value,
        fragment.style
      );
      output.push(className);
    }
    return output.join(" ");
  }

  const css = Object.assign(cssImpl, { raw: cssRaw });
  return { css };
}

// == Define Rules Impl ========================================================
interface InputIdentity {
  property: string;
  value: unknown;
}

interface ResolvedStyleFragment {
  source: {
    key: string;
    shortcutStack: string[];
  };
  inputIdentity: InputIdentity;
  outputKeys: string[];
  style: CSSProperties;
}

function collectEmittedFragments(
  fragments: readonly ResolvedStyleFragment[]
): ResolvedStyleFragment[] {
  const occupiedKeys = new Set<string>();
  const emittedFragments: ResolvedStyleFragment[] = [];

  for (let index = fragments.length - 1; index >= 0; index -= 1) {
    const fragment = fragments[index];
    if (fragment == null) continue;

    const emittedFragment = omitOccupiedKeys(fragment, occupiedKeys);
    if (emittedFragment == null) {
      continue;
    }

    emittedFragments.push(emittedFragment);

    for (const key of emittedFragment.outputKeys) {
      occupiedKeys.add(key);
    }
  }

  return emittedFragments.reverse();
}

function omitOccupiedKeys(
  fragment: ResolvedStyleFragment,
  occupiedKeys: ReadonlySet<string>
): ResolvedStyleFragment | undefined {
  const remainingOutputKeys = fragment.outputKeys.filter(
    (key) => !occupiedKeys.has(key)
  );

  if (remainingOutputKeys.length === 0) {
    return undefined;
  }

  if (remainingOutputKeys.length === fragment.outputKeys.length) {
    return fragment;
  }

  const nextStyle: Record<string, unknown> = {};

  for (const key of remainingOutputKeys) {
    nextStyle[key] = (fragment.style as Record<string, unknown>)[key];
  }

  return {
    ...fragment,
    outputKeys: remainingOutputKeys,
    style: nextStyle as CSSProperties
  };
}

function flattenResolvedFragments(
  fragments: readonly ResolvedStyleFragment[]
): CSSProperties {
  const mergedStyle: CSSProperties = {};

  for (const fragment of fragments) {
    Object.assign(mergedStyle, fragment.style);
  }

  return mergedStyle;
}

function pushResolvedFragment(
  fragmentsOut: ResolvedStyleFragment[],
  inputIdentity: InputIdentity,
  shortcutStack: readonly string[],
  style: CSSProperties
) {
  const outputKeys = Object.keys(style);
  if (outputKeys.length === 0) return;

  fragmentsOut.push({
    source: {
      key: inputIdentity.property,
      shortcutStack: [...shortcutStack]
    },
    inputIdentity,
    outputKeys,
    style
  });
}

function applyInput<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  input: unknown,
  shortcutStack: string[]
) {
  if (input == null || input === false) return;

  if (typeof input === "string") {
    applyInlineShortcut(ctx, fragmentsOut, input, shortcutStack);
    return;
  }

  if (Array.isArray(input)) {
    applyArray(ctx, fragmentsOut, input, shortcutStack);
    return;
  }

  if (isPlainObject(input)) {
    applyObject(ctx, fragmentsOut, input, shortcutStack);
    return;
  }

  throw new Error(`Unsupported css() argument: ${String(input)}`);
}

function applyInlineShortcut<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  shortcutName: string,
  shortcutStack: string[]
) {
  if (hasOwn(ctx.shortcuts, shortcutName)) {
    applyShortcut(ctx, fragmentsOut, shortcutName, undefined, shortcutStack);
    return;
  }
  throw new Error(`Unknown fixed style: "${shortcutName}"`);
}

function applyArray<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  arr: readonly unknown[],
  shortcutStack: string[]
) {
  for (const item of arr) {
    applyInput(ctx, fragmentsOut, item, shortcutStack);
  }
}

function applyObject<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  obj: Record<string, unknown>,
  shortcutStack: string[]
) {
  for (const [k, v] of Object.entries(obj)) {
    applyEntry(ctx, fragmentsOut, k, v, shortcutStack);
  }
}

function applyEntry<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  key: string,
  value: unknown,
  shortcutStack: string[]
) {
  if (hasOwn(ctx.shortcuts, key)) {
    applyShortcut(ctx, fragmentsOut, key, value, shortcutStack);
    return;
  }

  applyProperty(ctx, fragmentsOut, key, value, shortcutStack);
}

function applyProperty<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  prop: string,
  value: unknown,
  shortcutStack: string[]
) {
  const propertyDefinition = ctx.properties?.[prop as keyof Properties];

  if (typeof propertyDefinition === "function") {
    const result = propertyDefinition(value);
    if (isPlainObject(result)) {
      pushResolvedFragment(
        fragmentsOut,
        { property: prop, value },
        shortcutStack,
        result as CSSProperties
      );
      return;
    } else {
      pushResolvedFragment(
        fragmentsOut,
        { property: prop, value },
        shortcutStack,
        {
          [prop]: result
        } as CSSProperties
      );
      return;
    }
  }

  // just assign => last one wins
  if (isPlainObject(propertyDefinition) === false) {
    pushResolvedFragment(
      fragmentsOut,
      { property: prop, value },
      shortcutStack,
      {
        [prop]: value
      } as CSSProperties
    );
    return;
  }

  const mappedValue = propertyDefinition[value as string];

  // Style object value => assign all
  if (isPlainObject(mappedValue)) {
    pushResolvedFragment(
      fragmentsOut,
      { property: prop, value },
      shortcutStack,
      mappedValue as CSSProperties
    );
    return;
  }

  // Mapped value => assign mapped value
  pushResolvedFragment(fragmentsOut, { property: prop, value }, shortcutStack, {
    [prop]: mappedValue ?? value
  } as CSSProperties);
}

function applyShortcutReference<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  targetName: string,
  value: unknown,
  shortcutStack: string[]
) {
  if (hasOwn(ctx.shortcuts, targetName)) {
    applyShortcut(ctx, fragmentsOut, targetName, value, shortcutStack);
    return;
  }

  applyProperty(ctx, fragmentsOut, targetName, value, shortcutStack);
}

function applyShortcut<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  name: string,
  value: unknown,
  shortcutStack: string[]
) {
  if (shortcutStack.includes(name)) {
    throw new Error(
      `Circular shortcut reference: ${[...shortcutStack, name].join(" -> ")}`
    );
  }

  const shortcutDefinition = ctx.shortcuts?.[name as keyof Shortcuts];
  if (shortcutDefinition == null) return;

  const nextShortcutStack = shortcutStack.concat(name);

  if (typeof shortcutDefinition === "string") {
    // single alias: pl -> paddingLeft
    applyShortcutReference(
      ctx,
      fragmentsOut,
      shortcutDefinition,
      value,
      nextShortcutStack
    );
    return;
  }

  if (Array.isArray(shortcutDefinition)) {
    // multi alias: px -> [pl, pr]
    for (const alias of shortcutDefinition) {
      applyShortcutReference(
        ctx,
        fragmentsOut,
        alias,
        value,
        nextShortcutStack
      );
    }
    return;
  }

  if (typeof shortcutDefinition === "function") {
    // fn shortcut
    const produced = shortcutDefinition(value);
    applyInput(ctx, fragmentsOut, produced, nextShortcutStack);
    return;
  }

  if (isPlainObject(shortcutDefinition)) {
    // fixed style shortcut
    // - "inline" shortcut flag (no value) => apply
    // - { inline: true } => apply
    // - { inline: false } => do not apply
    if (value === undefined || value === true) {
      applyInput(ctx, fragmentsOut, shortcutDefinition, nextShortcutStack);
      return;
    }
    if (!value) return;
    applyInput(ctx, fragmentsOut, shortcutDefinition, nextShortcutStack);
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

  const debugId = "myCSS";
  setFileScope("test");

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

        expect(colorRed).toMatch(identifierName(debugId));

        expect(colorRed).toBe(css({ color: "red" }));
        expect(backgroundBlue).toBe(css({ background: "blue" }));
        expect(combined).toBe(css({ color: "red", background: "blue" }));
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
        const { css } = defineRules({
          properties: {
            paddingLeft: [0, 4, 8]
          },
          shortcuts: {
            a: "b",
            b: ["a"]
          }
        });

        // @ts-expect-error Type of property 'a' circularly references itself in mapped type 'ShortcutsInput<PropertiesInput<{ readonly paddingLeft: readonly [0, 4, 8]; }>, { readonly a: "b"; readonly b: readonly ["a"]; }>'.
        expect(() => css.raw({ a: 4 })).toThrow(
          "Circular shortcut reference: a -> b -> a"
        );
      });
    });
  });
}
