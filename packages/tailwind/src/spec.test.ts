import {
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  expectTypeOf
} from "vitest";
import { theme, defineRules } from "@mincho-js/css";
import type { Theme } from "@mincho-js/css";
import {
  mockAdapter,
  setAdapter,
  removeAdapter
} from "@vanilla-extract/css/adapter";
import { setFileScope, endFileScope } from "@vanilla-extract/css/fileScope";

import { themeSpec, utilityStyles } from "./index.js";
import type { TailwindScales, TailwindTokens } from "./index.js";

const tokens = {
  colors: { ink: "#17231a", paper: "white" },
  spacing: "0.25rem",
  fonts: { sans: "sans-serif" },
  fontSizes: { sm: { size: "0.875rem", lineHeight: "1.25rem" } },
  fontWeights: { bold: "700" },
  letterSpacings: { tight: "-0.025em" },
  lineHeights: { normal: "1.5" },
  radii: { lg: "0.5rem" },
  shadows: { sm: "0 1px 3px black" },
  insetShadows: { sm: "inset 0 1px 2px black" },
  dropShadows: { DEFAULT: ["0 1px 2px black", "0 1px 1px gray"] },
  textShadows: { sm: "0 1px 1px black" },
  easings: { out: "ease-out" },
  animations: { spin: "spin 1s linear infinite" },
  blurs: { sm: "8px" },
  perspectives: { normal: "500px" },
  aspectRatios: { video: "16 / 9" },
  containers: { sm: "24rem" },
  maxWidths: { prose: "65ch" },
  defaults: {
    transitionDuration: "150ms",
    transitionTimingFunction: "ease",
    fontFamily: "sans-serif",
    fontFeatureSettings: "normal",
    fontVariationSettings: "normal",
    monoFontFamily: "monospace",
    monoFontFeatureSettings: "normal",
    monoFontVariationSettings: "normal"
  }
} satisfies TailwindScales;

beforeEach(() => {
  setAdapter(mockAdapter);
  setFileScope("tailwind-test.css.ts", "@test/tailwind");
});

afterEach(() => {
  endFileScope();
  removeAdapter();
});

describe("native Tailwind styles", () => {
  it("authors Tailwind vocabulary with property conditions and fixed styles", () => {
    const [, vars] = theme({
      ...tokens,
      colors: { "blue-500": "#3b82f6", "blue-700": "#1d4ed8", white: "#fff" },
      radii: { ...tokens.radii, DEFAULT: "0.25rem" }
    });
    const { css } = defineRules(themeSpec(vars));

    expect(
      css.raw([
        {
          bg: { base: "blue-500", _hover: "blue-700" },
          text: "white",
          font: "bold",
          py: 2,
          px: 3
        },
        "rounded"
      ])
    ).toEqual({
      backgroundColor: vars.colors["blue-500"],
      color: vars.colors.white,
      fontWeight: vars.fontWeights.bold,
      paddingTop: `calc(${vars.spacing} * 2)`,
      paddingBottom: `calc(${vars.spacing} * 2)`,
      paddingLeft: `calc(${vars.spacing} * 3)`,
      paddingRight: `calc(${vars.spacing} * 3)`,
      borderRadius: vars.radii.DEFAULT,
      selectors: { "&:hover": { backgroundColor: vars.colors["blue-700"] } }
    });
    expect(css.raw({ text: "sm", font: "sans", rounded: false })).toEqual({
      fontSize: vars.fontSizes.sm.size,
      lineHeight: vars.fontSizes.sm.lineHeight,
      fontFamily: vars.fonts.sans
    });
    expect(css.raw({ rounded: "lg" })).toEqual({ borderRadius: vars.radii.lg });
  });

  it("composes spacing shortcuts as four independent atomic directions", () => {
    const [, vars] = theme(tokens);
    const { css, cx } = defineRules(themeSpec(vars));
    const atoms = (value: string) =>
      value
        .split(/\s+/)
        .filter((name) => !name.startsWith("__mincho_seg_"))
        .sort();

    const all = css({ p: { base: 4, _hover: 2, _md: 6 } });
    const sides = css({ px: 3, pl: 1 });
    const expected = css({
      pt: 4,
      pb: 4,
      pr: 3,
      pl: 1,
      _hover: { p: 2 },
      _md: { p: 6 }
    });

    expect(atoms(cx(all, sides))).toEqual(atoms(expected));
    expect(css.raw({ p: 4, px: 3, pl: 1 })).toEqual({
      paddingLeft: `calc(${vars.spacing} * 1)`,
      paddingRight: `calc(${vars.spacing} * 3)`,
      paddingTop: `calc(${vars.spacing} * 4)`,
      paddingBottom: `calc(${vars.spacing} * 4)`
    });
    expect(atoms(cx(css({ m: -4 }), css({ mx: -3, ml: 0 })))).toEqual(
      atoms(css({ mt: -4, mb: -4, mr: -3, ml: 0 }))
    );
  });

  it("resolves leading-none after named line-height tokens", () => {
    const [, vars] = theme(tokens);
    const { css } = defineRules(themeSpec(vars));

    expect(css.raw({ leading: "none" })).toEqual({ lineHeight: 1 });
    expect(css.raw({ leading: "normal" })).toEqual({
      lineHeight: vars.lineHeights.normal
    });
    expect(css.raw({ leading: "1.75rem" })).toEqual({
      lineHeight: "1.75rem"
    });

    const [, customVars] = theme({
      ...tokens,
      lineHeights: { ...tokens.lineHeights, none: "1.1" }
    });
    const custom = defineRules(themeSpec(customVars));

    expect(custom.css.raw({ leading: "none" })).toEqual({
      lineHeight: customVars.lineHeights.none
    });
  });

  it("uses static fallbacks only when their named theme tokens are absent", () => {
    const [, vars] = theme(tokens);
    const { css } = defineRules(themeSpec(vars));
    const input = {
      rounded: "none",
      borderTopLeftRadius: "full",
      perspective: "none",
      aspectRatio: "square",
      animate: "none",
      transitionTimingFunction: "linear",
      shadow: "none",
      textShadow: "none"
    } as const;

    expect(css.raw(input)).toEqual({
      borderRadius: "0px",
      borderTopLeftRadius: "calc(infinity * 1px)",
      perspective: "none",
      aspectRatio: "1 / 1",
      animation: "none",
      transitionTimingFunction: "linear",
      boxShadow: "none",
      textShadow: "none"
    });
    expect(css.raw({ aspectRatio: "auto" })).toEqual({ aspectRatio: "auto" });

    const [, customVars] = theme({
      ...tokens,
      radii: { ...tokens.radii, none: "2px", full: "12px" },
      perspectives: { ...tokens.perspectives, none: "800px" },
      aspectRatios: { ...tokens.aspectRatios, square: "2 / 1", auto: "3 / 2" },
      animations: { ...tokens.animations, none: "spin 2s linear infinite" },
      easings: { ...tokens.easings, linear: "cubic-bezier(0.2, 0, 0.8, 1)" },
      shadows: { ...tokens.shadows, none: "0 2px 4px black" },
      textShadows: { ...tokens.textShadows, none: "0 2px 4px black" }
    });
    const custom = defineRules(themeSpec(customVars));

    expect(custom.css.raw(input)).toEqual({
      borderRadius: customVars.radii.none,
      borderTopLeftRadius: customVars.radii.full,
      perspective: customVars.perspectives.none,
      aspectRatio: customVars.aspectRatios.square,
      animation: customVars.animations.none,
      transitionTimingFunction: customVars.easings.linear,
      boxShadow: "none",
      textShadow: "none"
    });
    expect(custom.css.raw({ aspectRatio: "auto" })).toEqual({
      aspectRatio: customVars.aspectRatios.auto
    });
  });

  it("binds named tokens, directional spacing and paired typography", () => {
    expectTypeOf<TailwindTokens>().toMatchTypeOf<Theme>();

    const [, vars] = theme(tokens);
    const { css } = defineRules(themeSpec(vars));

    expect(
      css.raw({
        color: "ink",
        bg: "paper",
        px: 4,
        my: -2,
        fontSize: "sm",
        rounded: "lg"
      })
    ).toEqual({
      color: vars.colors.ink,
      backgroundColor: vars.colors.paper,
      paddingLeft: `calc(${vars.spacing} * 4)`,
      paddingRight: `calc(${vars.spacing} * 4)`,
      marginTop: `calc(${vars.spacing} * -2)`,
      marginBottom: `calc(${vars.spacing} * -2)`,
      fontSize: vars.fontSizes.sm.size,
      lineHeight: vars.fontSizes.sm.lineHeight,
      borderRadius: vars.radii.lg
    });
    expect(
      css.raw({ color: "current", fill: "none", rounded: "full" })
    ).toEqual({
      color: "currentColor",
      fill: "none",
      borderRadius: "calc(infinity * 1px)"
    });

    const _config = themeSpec(vars);
    expectTypeOf<
      Extract<"ink" | "missing", keyof typeof _config.properties.color>
    >().toEqualTypeOf<"ink">();
  });

  it("declares native layout values without widening mapped tokens", () => {
    const [, vars] = theme(tokens);
    const config = themeSpec(vars);
    const { css } = defineRules(config);
    type Input = Parameters<typeof css>[0];
    const layout = {
      display: { base: "flex", _sm: "inline-flex" },
      position: "relative",
      flexWrap: "wrap",
      alignItems: "center",
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      border: "1px solid currentColor",
      cursor: "pointer"
    } as const satisfies Input;

    expect(css.raw(layout)).toEqual({
      display: "flex",
      position: "relative",
      flexWrap: "wrap",
      alignItems: "center",
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      border: "1px solid currentColor",
      cursor: "pointer",
      "@media": { "(width >= 40rem)": { display: "inline-flex" } }
    });
    expect(config.properties.color.ink).toBe(vars.colors.ink);
    expect(config.properties.borderColor).toBe(config.properties.color);

    // @ts-expect-error Registered color scales retain their token vocabulary.
    const invalidColor: Input = { color: "rebeccapurple" };
    // @ts-expect-error Unregistered native properties remain outside the contract.
    const invalidProperty: Input = { tableLayout: "fixed" };
    void invalidColor;
    void invalidProperty;
  });

  it("resolves quarter spacing, raw lengths, fractions and sizing keywords", () => {
    const [, vars] = theme(tokens);
    const { css } = defineRules(themeSpec(vars));

    expect(
      css.raw({
        p: 1.25,
        m: "auto",
        gap: "px",
        w: "1/2",
        h: "dvh",
        maxWidth: "prose"
      })
    ).toEqual({
      paddingLeft: `calc(${vars.spacing} * 1.25)`,
      paddingRight: `calc(${vars.spacing} * 1.25)`,
      paddingTop: `calc(${vars.spacing} * 1.25)`,
      paddingBottom: `calc(${vars.spacing} * 1.25)`,
      marginLeft: "auto",
      marginRight: "auto",
      marginTop: "auto",
      marginBottom: "auto",
      gap: "1px",
      width: "calc(1 / 2 * 100%)",
      height: "100dvh",
      maxWidth: vars.maxWidths.prose
    });
    expect(css.raw({ width: "sm", height: "10rem", leading: 6 })).toEqual({
      width: vars.containers.sm,
      height: "10rem",
      lineHeight: `calc(${vars.spacing} * 6)`
    });
    expect(css.raw({ size: "sm" })).toEqual({
      width: vars.containers.sm,
      height: vars.containers.sm
    });
    expect(css.raw({ h: "sm", minHeight: "sm", maxHeight: "sm" })).toEqual({
      height: vars.containers.sm,
      minHeight: vars.containers.sm,
      maxHeight: vars.containers.sm
    });
    expect(css.raw({ size: "screen" })).toEqual({
      width: "100vw",
      height: "100vh"
    });
    for (const p of [-1, 0.1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => css.raw({ p })).toThrow("spacing");

    expect(() => css.raw({ w: "1/0" })).toThrow("fraction");
  });

  it("keeps breakpoints literal, sorted, and names the numeric 2xl alias", () => {
    const [, vars] = theme(tokens);
    const config = themeSpec(vars);

    expect(config.conditions.screen2xl).toEqual({
      "@media": "(width >= 96rem)"
    });
    expect(defineRules(config).css.raw({ _sm: { p: 4 } })).toEqual({
      "@media": {
        "(width >= 40rem)": {
          paddingLeft: `calc(${vars.spacing} * 4)`,
          paddingRight: `calc(${vars.spacing} * 4)`,
          paddingTop: `calc(${vars.spacing} * 4)`,
          paddingBottom: `calc(${vars.spacing} * 4)`
        }
      }
    });

    const custom = themeSpec(vars, {
      large: "80rem",
      small: "40rem",
      omitted: undefined
    });
    expect(Object.keys(custom.conditions)).toEqual(["small", "large"]);
    expectTypeOf(custom.conditions.small).toEqualTypeOf<{ "@media": string }>();
    expect(defineRules(custom).css.raw({ container: true })).toEqual({
      width: "100%",
      "@media": {
        "(width >= 40rem)": { maxWidth: "40rem" },
        "(width >= 80rem)": { maxWidth: "80rem" }
      }
    });
    expect(() =>
      themeSpec(vars, { "2xl": "96rem", screen2xl: "100rem" })
    ).toThrow("Duplicate");
    expect(() => themeSpec(vars, { wide: " " })).toThrow("Invalid");

    const numeric = themeSpec(vars, { 640: "40rem" });
    expectTypeOf<
      keyof typeof numeric.conditions
    >().toEqualTypeOf<"screen640">();
    expect(numeric.conditions.screen640).toEqual({
      "@media": "(width >= 40rem)"
    });
    expect(defineRules(numeric).css.raw({ _screen640: { p: 4 } })).toEqual({
      "@media": {
        "(width >= 40rem)": {
          paddingLeft: `calc(${vars.spacing} * 4)`,
          paddingRight: `calc(${vars.spacing} * 4)`,
          paddingTop: `calc(${vars.spacing} * 4)`,
          paddingBottom: `calc(${vars.spacing} * 4)`
        }
      }
    });
  });

  it("does not promise keys in a dynamic breakpoint dictionary", () => {
    const [, vars] = theme(tokens);
    const dynamic: Record<string, string> = {};
    const config = themeSpec(vars, dynamic);

    expect(config.conditions.wide).toBeUndefined();
    expectTypeOf(config.conditions.wide).toEqualTypeOf<
      { "@media": string } | undefined
    >();
    expect(defineRules(config).css.raw({ p: 2 })).toEqual({
      paddingLeft: `calc(${vars.spacing} * 2)`,
      paddingRight: `calc(${vars.spacing} * 2)`,
      paddingTop: `calc(${vars.spacing} * 2)`,
      paddingBottom: `calc(${vars.spacing} * 2)`
    });

    const numeric: Record<number, string> = {};
    const numericConfig = themeSpec(vars, numeric);
    expectTypeOf(numericConfig.conditions.screen640).toEqualTypeOf<
      { "@media": string } | undefined
    >();
    expect(numericConfig.conditions.screen640).toBeUndefined();
  });

  it("ports accessibility, truncation and line-clamp reset declarations", () => {
    const [, vars] = theme(tokens);
    const { css } = defineRules(themeSpec(vars));

    expect(css.raw({ srOnly: true })).toEqual(utilityStyles.srOnly);
    expect(css.raw({ notSrOnly: true })).toEqual(utilityStyles.notSrOnly);
    expect(css.raw({ truncate: true })).toEqual(utilityStyles.truncate);
    expect(css.raw({ lineClamp: 3 })).toEqual({
      overflow: "hidden",
      display: "-webkit-box",
      WebkitBoxOrient: "vertical",
      WebkitLineClamp: 3
    });
    expect(css.raw({ lineClamp: "none" })).toEqual({
      overflow: "visible",
      display: "block",
      WebkitBoxOrient: "horizontal",
      WebkitLineClamp: "unset"
    });
    expect(() => css.raw({ lineClamp: 0 })).toThrow("positive integer");
  });

  it("retains every entry in a multi-shadow filter", () => {
    const [, vars] = theme(tokens);
    const { css } = defineRules(themeSpec(vars));

    expect(css.raw({ dropShadow: "DEFAULT" })).toEqual({
      filter: vars.dropShadows.DEFAULT.map(
        (value) => `drop-shadow(${value})`
      ).join(" ")
    });
  });

  it("creates native recipes and composes generated classes", () => {
    const [themeClass, vars] = theme(tokens);
    const { css, rules, cx } = defineRules(themeSpec(vars));
    const button = rules({
      base: { px: 4, py: 2, rounded: "lg" },
      variants: {
        tone: {
          solid: { bg: "ink", color: "paper" },
          soft: { bg: "paper", color: "ink" }
        }
      }
    });
    const red = css({ color: "ink" });
    const white = css({ color: "paper" });

    expect(button({ tone: "solid" })).toContain(
      button.classNames.variants.tone.solid
    );
    expect(cx(red, white)).toBe(white);
    expect(cx(themeClass, button({ tone: "soft" }))).toContain(themeClass);
  });
});
