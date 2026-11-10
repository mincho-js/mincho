import { describe, it, expect, expectTypeOf } from "vitest";

import { normalizeTheme } from "./normalize.js";
import type { NormalizedTokens } from "./normalize.js";
import type { Theme } from "./schema.js";

describe("normalized scales", () => {
  it("replaces defaults separately for each source-union alternative", () => {
    type Spaced = { space: readonly [1, 2] };
    type Colored = {
      colors: { text: string; modes: { dark: { text: string } } };
    };
    type Source = Spaced | Colored;
    const normalizeSource = (source: Source) => normalizeTheme(source);
    const custom = normalizeSource({ space: [1, 2] });
    const fallback = normalizeSource({
      colors: { text: "black", modes: { dark: { text: "white" } } }
    });

    expect(custom.tokens.space).toEqual({ 0: "1px", 1: "2px" });
    expect(fallback.tokens.space).toMatchObject({ 0: "0px", 8: "512px" });
    expect(custom.modes.dark).toBeUndefined();
    expect(fallback.modes.dark).toMatchObject({ colors: { text: "white" } });
    expectTypeOf(custom.tokens).toEqualTypeOf<
      NormalizedTokens<Spaced> | NormalizedTokens<Colored>
    >();
    expectTypeOf(custom.modes.dark).toEqualTypeOf<
      NormalizedTokens<Source> | undefined
    >();
    expectTypeOf<keyof typeof custom.tokens.space>().toEqualTypeOf<0 | 1>();
    // @ts-expect-error The custom spacing alternative has no entry at index 8.
    expect(custom.tokens.space[8]).toBeUndefined();
  });

  it("includes fallback shapes for optional default scales", () => {
    type Source = {
      space?: { compact: number };
      fontSizes?: readonly [10, 20];
    };
    const normalizeSource = (source: Source) => normalizeTheme(source);
    const omitted = normalizeSource({});
    const supplied = normalizeSource({
      space: { compact: 2 },
      fontSizes: [10, 20]
    });
    const undefinedScales = normalizeSource({
      space: undefined,
      fontSizes: undefined
    });

    expect(omitted.tokens.space).toMatchObject({ 0: "0px", 8: "512px" });
    expect(omitted.tokens.fontSizes).toMatchObject({ 0: "12px", 8: "72px" });
    expect(supplied.tokens.space).toEqual({ compact: "2px" });
    expect(supplied.tokens.fontSizes).toEqual({ 0: "10px", 1: "20px" });
    expect(undefinedScales.tokens).not.toHaveProperty("space");
    expect(undefinedScales.tokens).not.toHaveProperty("fontSizes");
    expectTypeOf(omitted.tokens.space).toEqualTypeOf<
      | NormalizedTokens<Record<never, never>>["space"]
      | { compact: string }
      | undefined
    >();
    expectTypeOf(omitted.tokens.fontSizes).toEqualTypeOf<
      | NormalizedTokens<Record<never, never>>["fontSizes"]
      | { 0: string; 1: string }
      | undefined
    >();
    // @ts-expect-error Omitting the custom scale supplies numeric default keys.
    expect(omitted.tokens.space?.compact).toBeUndefined();
  });

  it("keeps optional color alternatives and their modes optional", () => {
    type OptionalColors = {
      colors?: { text: string; modes?: { dark: { text: string } } };
    };
    type Spaced = { space: readonly [1, 2] };
    type Source = OptionalColors | Spaced;
    const normalizeSource = (source: Source) => normalizeTheme(source);
    const missing = normalizeSource({});

    expect(missing.tokens).not.toHaveProperty("colors");
    expect(missing.modes.dark).toBeUndefined();
    expectTypeOf(missing.tokens).toEqualTypeOf<
      NormalizedTokens<OptionalColors> | NormalizedTokens<Spaced>
    >();
    expectTypeOf(missing.modes.dark).toEqualTypeOf<
      NormalizedTokens<Source> | undefined
    >();
  });
});

describe("normalized color modes", () => {
  it("preserves noncanonical numeric keys without widening array indices", () => {
    const normalized = normalizeTheme({
      colors: {
        "1": "black",
        "01": "gray",
        "1.0": "silver",
        "1e2": "white",
        palette: ["red", "blue"],
        modes: {
          dark: {
            "01": "white",
            palette: ["gold", "silver"]
          }
        }
      }
    });

    expect(normalized.tokens.colors).toEqual({
      1: "black",
      "01": "gray",
      "1.0": "silver",
      "1e2": "white",
      palette: { 0: "red", 1: "blue" }
    });
    expect(normalized.modes.dark.colors["01"]).toBe("white");
    expect(normalized.modes.dark.colors.palette[1]).toBe("silver");
    expectTypeOf<keyof typeof normalized.tokens.colors>().toEqualTypeOf<
      1 | "01" | "1.0" | "1e2" | "palette"
    >();
    expectTypeOf(normalized.tokens.colors["01"]).toEqualTypeOf<string>();
    expectTypeOf(normalized.modes.dark.colors["01"]).toEqualTypeOf<string>();
    expectTypeOf<keyof typeof normalized.tokens.colors.palette>().toEqualTypeOf<
      0 | 1
    >();
    // @ts-expect-error The token "01" does not introduce a numeric index signature.
    expect(normalized.tokens.colors[2]).toBeUndefined();
    // @ts-expect-error The token "1e2" is distinct from the numeric key 100.
    expect(normalized.modes.dark.colors[100]).toBeUndefined();
    // @ts-expect-error A readonly source tuple only contains its declared indices.
    expect(normalized.tokens.colors.palette[2]).toBeUndefined();
  });

  it("omits explicitly undefined optional modes", () => {
    const source: {
      colors: {
        text: string;
        modes: { dark: { text: string }; dim?: { text: string } };
      };
    } = {
      colors: {
        text: "black",
        modes: { dark: { text: "white" }, dim: undefined }
      }
    };
    const normalized = normalizeTheme(source);

    expect(Object.keys(normalized.modes)).toEqual(["dark"]);
    expect(normalized.modes.dark.colors.text).toBe("white");
    expect(normalized.modes.dim).toBeUndefined();
    expectTypeOf(normalized.modes.dim).toEqualTypeOf<
      typeof normalized.tokens | undefined
    >();
    expect(source.colors.modes).toEqual({
      dark: { text: "white" },
      dim: undefined
    });
  });

  it("preserves exact required names for literal themes", () => {
    const normalized = normalizeTheme({
      colors: {
        text: "black",
        modes: { dark: { text: "white" } }
      }
    });

    expectTypeOf<keyof typeof normalized.modes>().toEqualTypeOf<"dark">();
    expectTypeOf(normalized.modes.dark).toEqualTypeOf<
      typeof normalized.tokens
    >();
    expect(normalized.modes.dark.colors.text).toBe("white");
  });

  it("exposes possibly absent modes for sources annotated as Theme", () => {
    const source: Theme = {
      colors: { text: "black", modes: { dark: { text: "white" } } }
    };
    const normalized = normalizeTheme(source);
    const absent: Theme = {};

    expect(normalized.modes.dark?.colors?.text).toBe("white");
    expect(normalizeTheme(absent).modes.dark).toBeUndefined();
    expectTypeOf(normalized.modes.dark).toEqualTypeOf<
      NormalizedTokens<Theme> | undefined
    >();
  });

  it("does not guarantee modes behind optional source fields", () => {
    const source: {
      colors?: { text: string; modes?: { dark: { text: string } } };
    } = {};
    const normalized = normalizeTheme(source);

    expect(normalized.modes.dark).toBeUndefined();
    expectTypeOf(normalized.modes.dark).toEqualTypeOf<
      typeof normalized.tokens | undefined
    >();

    const _withoutColors = normalizeTheme({ colors: undefined });
    const _withoutModes = normalizeTheme({
      colors: { text: "black", modes: undefined }
    });

    expectTypeOf<keyof typeof _withoutColors.modes>().toEqualTypeOf<never>();
    expectTypeOf<keyof typeof _withoutModes.modes>().toEqualTypeOf<never>();
  });

  it("collects mode-only colors that shadow inherited property names", () => {
    const normalized = normalizeTheme({
      colors: {
        text: "black",
        nested: { text: "gray" },
        modes: {
          dark: { toString: "white", nested: { constructor: "silver" } }
        }
      }
    });

    expect(normalized.tokens.colors).toEqual({
      text: "black",
      toString: "initial",
      nested: { text: "gray", constructor: "initial" }
    });
    expect(normalized.modes.dark.colors).toEqual({
      text: "black",
      toString: "white",
      nested: { text: "gray", constructor: "silver" }
    });
    expect(Object.hasOwn(normalized.tokens.colors, "toString")).toBe(true);
    expect(Object.hasOwn(normalized.tokens.colors.nested, "constructor")).toBe(
      true
    );
  });

  it("preserves mode-only __proto__ groups and tokens as own data", () => {
    const source = {
      colors: {
        text: "black",
        modes: {
          dark: {
            ["__proto__"]: { accent: "gold" },
            nested: { ["__proto__"]: "white" }
          },
          dim: {
            ["__proto__"]: { accent: "silver" },
            nested: { ["__proto__"]: "gray" }
          }
        }
      }
    };
    const normalized = normalizeTheme(source);

    expect(normalized.tokens.colors.__proto__).toEqual({ accent: "initial" });
    expect(normalized.tokens.colors.nested.__proto__).toBe("initial");
    expect(normalized.modes.dark.colors.__proto__).toEqual({ accent: "gold" });
    expect(normalized.modes.dark.colors.nested.__proto__).toBe("white");
    expect(normalized.modes.dim.colors.__proto__).toEqual({ accent: "silver" });
    expect(normalized.modes.dim.colors.nested.__proto__).toBe("gray");

    for (const { colors } of [
      normalized.tokens,
      normalized.modes.dark,
      normalized.modes.dim
    ]) {
      expect(Object.hasOwn(colors, "__proto__")).toBe(true);
      expect(Object.hasOwn(colors.nested, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(colors)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(colors.__proto__)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(colors.nested)).toBe(Object.prototype);
    }

    expect(source.colors.modes.dark.__proto__).toEqual({ accent: "gold" });
    expect(source.colors.modes.dark.nested.__proto__).toBe("white");
  });

  it("collects possibly absent colors from optional modes", () => {
    type Source = {
      colors: {
        text: string;
        modes?: { dark: { accent: string; nested: { muted: string } } };
      };
    };
    const present: Source = {
      colors: {
        text: "black",
        modes: { dark: { accent: "gold", nested: { muted: "gray" } } }
      }
    };
    const absent: Source = { colors: { text: "black" } };
    const normalized = normalizeTheme(present);
    const missing = normalizeTheme(absent);

    expect(normalized.tokens.colors.accent).toBe("initial");
    expect(normalized.modes.dark?.colors.accent).toBe("gold");
    expect(missing.tokens.colors.accent).toBeUndefined();
    expect(missing.tokens.colors.nested).toBeUndefined();
    expectTypeOf(normalized.tokens.colors.text).toEqualTypeOf<string>();
    expectTypeOf(normalized.tokens.colors.accent).toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf(normalized.tokens.colors.nested?.muted).toEqualTypeOf<
      string | undefined
    >();
  });

  it("preserves absent colors in nested source-union alternatives", () => {
    const normalizePalette = (
      palette: { text: string; light: string } | { text: string; dark: string }
    ) => normalizeTheme({ colors: { palette } });
    const normalized = normalizePalette({ text: "gray", dark: "black" });

    expect(normalized.tokens.colors.palette).toEqual({
      text: "gray",
      dark: "black"
    });
    expect(normalized.tokens.colors.palette.light).toBeUndefined();
    expectTypeOf(normalized.tokens.colors.palette.text).toEqualTypeOf<string>();
    expectTypeOf(normalized.tokens.colors.palette.light).toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf(normalized.tokens.colors.palette.dark).toEqualTypeOf<
      string | undefined
    >();
  });

  it("collects mode colors while preserving source-union absences", () => {
    const normalizePalette = (
      palette: { light: string } | { nested: { muted: string } },
      contrast: { dark: string } | { dim: string }
    ) =>
      normalizeTheme({
        colors: {
          palette,
          modes: {
            contrast: { palette: contrast },
            highContrast: { palette: { nested: { text: "white" } } }
          }
        }
      });
    const normalized = normalizePalette({ light: "white" }, { dark: "black" });

    expect(normalized.tokens.colors.palette).toEqual({
      light: "white",
      dark: "initial",
      nested: { text: "initial" }
    });
    expect(normalized.modes.contrast.colors.palette.dark).toBe("black");
    expectTypeOf(normalized.tokens.colors.palette.light).toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf(normalized.tokens.colors.palette.dark).toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf(normalized.tokens.colors.palette.dim).toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf(
      normalized.tokens.colors.palette.nested.text
    ).toEqualTypeOf<string>();
    expectTypeOf(normalized.tokens.colors.palette.nested.muted).toEqualTypeOf<
      string | undefined
    >();
  });
});
