import {
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  expectTypeOf
} from "vitest";
import { theme, defineRules } from "@mincho-js/css";
import {
  mockAdapter,
  setAdapter,
  removeAdapter
} from "@vanilla-extract/css/adapter";
import { setFileScope, endFileScope } from "@vanilla-extract/css/fileScope";

import { themeSpec, scaleProperties } from "./index.js";

const tokens = {
  colors: { primary: "blue", secondary: "purple", muted: "gray" },
  space: { 0: "0px", 1: "4px", 2: "8px", 3: "16px" }
};

beforeEach(() => {
  setAdapter(mockAdapter);
  setFileScope("spec.css.ts", "@test/theme-ui");
});

afterEach(() => {
  endFileScope();
  removeAdapter();
});

describe("Theme Spec bindings", () => {
  it("allows ordinary CSS when optional scales are absent", () => {
    const [, vars] = theme({
      ...tokens,
      space: { ...tokens.space, compact: "6px" },
      zIndices: { modal: "100" }
    });
    const createDefinition = (scales: Partial<typeof vars>) =>
      defineRules(themeSpec(scales));
    const absent = createDefinition({});
    const present = createDefinition(vars);
    const required = defineRules(themeSpec(vars));

    expect(absent.css.raw({ color: "#111", zIndex: 2, px: "8px" })).toEqual({
      color: "#111",
      zIndex: 2,
      paddingLeft: "8px",
      paddingRight: "8px"
    });
    expect(absent.css({ color: "#111", zIndex: 2, px: "8px" })).toEqual(
      expect.any(String)
    );
    expect(
      present.css.raw({ color: "primary", zIndex: "modal", mx: "-compact" })
    ).toEqual({
      color: vars.colors.primary,
      zIndex: vars.zIndices.modal,
      marginLeft: `calc(${vars.space.compact} * -1)`,
      marginRight: `calc(${vars.space.compact} * -1)`
    });
    expect(
      required.css({ color: "primary", zIndex: "modal", px: "compact" })
    ).toEqual(expect.any(String));

    const invalid = () => {
      // @ts-expect-error Required color scales constrain values to their tokens.
      required.css({ color: "#111" });
      // @ts-expect-error Required named scales do not accept unknown tokens.
      required.css({ zIndex: "unknown" });
    };
    void invalid;
  });

  it("retains array aliases and bounds fixed tuple indices", () => {
    const [, vars] = theme(tokens);
    const space = Object.assign([vars.space[0], vars.space[1]], {
      sm: vars.space[2],
      group: { large: vars.space[3] }
    });
    const config = themeSpec({ space });
    const definition = defineRules(config);

    expect(
      definition.css.raw({ p: "sm", m: "-sm", gap: "group.large", top: 1 })
    ).toEqual({
      paddingLeft: vars.space[2],
      paddingRight: vars.space[2],
      paddingTop: vars.space[2],
      paddingBottom: vars.space[2],
      marginLeft: `calc(${vars.space[2]} * -1)`,
      marginRight: `calc(${vars.space[2]} * -1)`,
      marginTop: `calc(${vars.space[2]} * -1)`,
      marginBottom: `calc(${vars.space[2]} * -1)`,
      gap: vars.space[3],
      top: vars.space[1]
    });
    expectTypeOf<
      Extract<"map" | "length", keyof typeof config.properties.padding>
    >().toEqualTypeOf<never>();
    expectTypeOf<number>().toMatchTypeOf<
      keyof typeof config.properties.padding
    >();

    const tuple = Object.assign([vars.space[0], vars.space[1]] as const, {
      sm: vars.space[2]
    });
    const fixed = themeSpec({ space: tuple });

    expectTypeOf<
      Extract<0 | 1 | 2 | "sm", keyof typeof fixed.properties.padding>
    >().toEqualTypeOf<0 | 1 | "sm">();
    expectTypeOf<
      Extract<-2, keyof typeof fixed.properties.margin>
    >().toEqualTypeOf<never>();
    expect(defineRules(fixed).css.raw({ px: 1, m: -1, gap: "sm" })).toEqual({
      paddingLeft: vars.space[1],
      paddingRight: vars.space[1],
      marginLeft: `calc(${vars.space[1]} * -1)`,
      marginRight: `calc(${vars.space[1]} * -1)`,
      marginTop: `calc(${vars.space[1]} * -1)`,
      marginBottom: `calc(${vars.space[1]} * -1)`,
      gap: vars.space[2]
    });

    const _empty = themeSpec({ space: [] as const });

    expectTypeOf<
      Extract<0, keyof typeof _empty.properties.padding>
    >().toEqualTypeOf<never>();
  });

  it("resolves token indices, aliases, negative spacing and scoped recipe overrides", () => {
    const [, vars] = theme(tokens);
    const definition = defineRules(themeSpec(vars));

    expect(definition.css.raw({ p: 2, mx: -3, color: "primary" })).toEqual({
      paddingLeft: vars.space[2],
      paddingRight: vars.space[2],
      paddingTop: vars.space[2],
      paddingBottom: vars.space[2],
      marginLeft: `calc(${vars.space[3]} * -1)`,
      marginRight: `calc(${vars.space[3]} * -1)`,
      color: vars.colors.primary
    });
    expect(definition.css.raw({ px: 2, pl: 1 })).toEqual({
      paddingLeft: vars.space[1],
      paddingRight: vars.space[2]
    });
    expect(
      definition.css.raw({ bg: { base: "primary", _hover: "secondary" } })
    ).toEqual({
      backgroundColor: vars.colors.primary,
      selectors: { "&:hover": { backgroundColor: vars.colors.secondary } }
    });

    const atoms = (value: string) =>
      value
        .split(/\s+/)
        .filter((name) => !name.startsWith("__mincho_seg_"))
        .sort();
    const all = definition.css({ p: 3, _sm: { p: 2 } });
    const sides = definition.css({ px: 2, pl: 1 });
    const expected = definition.css({
      pt: 3,
      pb: 3,
      pr: 2,
      pl: 1,
      _sm: { p: 2 }
    });

    expect(atoms(definition.cx(all, sides))).toEqual(atoms(expected));

    const recipe = definition.rules({
      variants: {
        tone: { primary: { color: "primary" }, muted: { color: "muted" } }
      }
    });
    expect(recipe({ tone: "muted" })).toContain(
      recipe.classNames.variants.tone.muted
    );

    const first = definition.css({ color: "primary" });
    const last = definition.css({ color: "secondary" });
    expect(definition.cx(first, last)).toBe(last);

    const extension = defineRules.extends(definition, {
      properties: { color: { custom: "red" } }
    });
    expect(extension.css.raw({ color: "custom" })).toEqual({ color: "red" });
  });

  it("maps every scale association, nested token paths and logical/SVG properties", () => {
    const [, vars] = theme({
      colors: { brand: { primary: "red" } },
      space: { sm: "8px" },
      fonts: { body: "sans-serif" },
      fontSizes: { small: "12px" },
      fontWeights: { bold: 700 },
      lineHeights: { body: 1.5 },
      letterSpacings: { tight: "-1px" },
      opacities: { faint: 0.5 },
      transitions: { fast: "all 100ms" },
      borders: { thin: "1px solid" },
      borderWidths: { thin: "1px" },
      borderStyles: { plain: "solid" },
      radii: { round: "4px" },
      shadows: { low: "0 1px 2px black" },
      sizes: { wide: "40rem" },
      zIndices: { modal: 100 }
    });
    const config = themeSpec(vars);

    for (const [scale, properties] of Object.entries(scaleProperties)) {
      for (const property of properties)
        expect(config.properties[property]).toEqual(
          expect.objectContaining(
            scale === "colors"
              ? { "brand.primary": vars.colors.brand.primary }
              : vars[scale as keyof typeof vars]
          )
        );
    }

    const definition = defineRules(config);
    expect(
      definition.css.raw({
        fill: "brand.primary",
        paddingInlineStart: "sm",
        insetInline: "-sm",
        borderStartEndRadius: "round"
      })
    ).toEqual({
      fill: vars.colors.brand.primary,
      paddingInlineStart: vars.space.sm,
      insetInline: `calc(${vars.space.sm} * -1)`,
      borderStartEndRadius: vars.radii.round
    });
  });

  it("uses named responsive conditions and preserves complete media queries", () => {
    const [, vars] = theme(tokens);
    const definition = defineRules(
      themeSpec(vars, {
        wide: "@media (min-width: 56em) and (orientation: landscape)"
      })
    );
    expect(definition.css.raw({ _wide: { px: 2 } })).toEqual({
      "@media": {
        "(min-width: 56em) and (orientation: landscape)": {
          paddingLeft: vars.space[2],
          paddingRight: vars.space[2]
        }
      }
    });

    expect(() => themeSpec(vars, { blank: " " })).toThrow(
      "Empty Theme UI breakpoint"
    );
  });

  it("distinguishes length breakpoints from unprefixed media conditions", () => {
    const [, vars] = theme(tokens);
    const definition = defineRules(
      themeSpec(vars, {
        wide: "screen and (min-width: 56em)",
        canHover: "(hover: hover)",
        print: "print",
        small: "40em",
        calculated: "calc(40em + 1px)"
      })
    );

    expect(definition.css.raw({ _wide: { px: 2 } })).toEqual({
      "@media": {
        "screen and (min-width: 56em)": {
          paddingLeft: vars.space[2],
          paddingRight: vars.space[2]
        }
      }
    });
    expect(definition.css.raw({ _canHover: { color: "primary" } })).toEqual({
      "@media": { "(hover: hover)": { color: vars.colors.primary } }
    });
    expect(definition.css.raw({ _print: { p: 1 }, _small: { p: 2 } })).toEqual({
      "@media": {
        print: {
          paddingLeft: vars.space[1],
          paddingRight: vars.space[1],
          paddingTop: vars.space[1],
          paddingBottom: vars.space[1]
        },
        "screen and (min-width: 40em)": {
          paddingLeft: vars.space[2],
          paddingRight: vars.space[2],
          paddingTop: vars.space[2],
          paddingBottom: vars.space[2]
        }
      }
    });
    expect(definition.css.raw({ _calculated: { p: 1 } })).toEqual({
      "@media": {
        "screen and (min-width: calc(40em + 1px))": {
          paddingLeft: vars.space[1],
          paddingRight: vars.space[1],
          paddingTop: vars.space[1],
          paddingBottom: vars.space[1]
        }
      }
    });
  });

  it.each([
    "var(--breakpoint)",
    "calc(var(--breakpoint) + 1px)",
    "(min-width: var(--breakpoint))",
    "@media (min-width: var(--breakpoint))"
  ])("rejects CSS variables in breakpoint %s", (breakpoint) => {
    const [, vars] = theme(tokens);

    expect(() => themeSpec(vars, { wide: breakpoint })).toThrow(
      "Theme UI breakpoints cannot use CSS variables in media queries"
    );
  });

  it("does not promise missing keys for dynamic breakpoint collections", () => {
    const [, vars] = theme(tokens);
    const empty = themeSpec(vars, [] as string[]);
    const names: Record<string, string> = {};
    const named = themeSpec(vars, names);

    expect(empty.conditions.sm).toBeUndefined();
    expect(named.conditions.wide).toBeUndefined();
    expectTypeOf(empty.conditions.sm).toEqualTypeOf<
      { "@media": string } | undefined
    >();
    expectTypeOf(named.conditions.wide).toEqualTypeOf<
      { "@media": string } | undefined
    >();
    expect(() => {
      defineRules(empty);
      defineRules(named);
    }).not.toThrow();

    const optional: { wide?: string } = { wide: undefined };
    const sparse: string[] = [];
    sparse[2] = "64em";

    expect(themeSpec(vars, optional).conditions).toEqual({});
    expect(themeSpec(vars, sparse).conditions).toEqual({
      lg: { "@media": "screen and (min-width: 64em)" }
    });

    const dynamic = themeSpec(vars, ["40em", "52em"] as string[]);

    expect(defineRules(dynamic).css.raw({ _md: { p: 1 } })).toEqual({
      "@media": {
        "screen and (min-width: 52em)": {
          paddingLeft: vars.space[1],
          paddingRight: vars.space[1],
          paddingTop: vars.space[1],
          paddingBottom: vars.space[1]
        }
      }
    });
  });

  it("keeps definition serialization data-only", () => {
    const [, vars] = theme(tokens);
    const definition = defineRules(themeSpec(vars));
    definition.css({ color: "primary", _sm: { px: 2 } });

    const serialized = definition.css as typeof definition.css & {
      __recipe__: { args: unknown[] };
    };

    expect(() => JSON.stringify(serialized.__recipe__.args)).not.toThrow();
    expect(JSON.parse(JSON.stringify(serialized.__recipe__.args))).toEqual(
      serialized.__recipe__.args
    );
  });
});
