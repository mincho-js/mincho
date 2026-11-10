import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  Theme as UpstreamTheme,
  ThemeUIStyleObject as UpstreamStyle
} from "@theme-ui/css";

import { normalizeTheme } from "./index.js";
import type { Theme, ThemeScales, ThemeUIStyleObject } from "./index.js";

type ArrayScaleName = Exclude<keyof ThemeScales, "colors">;

type ScalesAccepting<Leaf> = {
  [K in ArrayScaleName]: readonly [Leaf] extends ThemeScales[K] ? K : never;
}[ArrayScaleName];

describe("Theme UI source types", () => {
  it("preserves upstream theme fields and accepts the original style format", () => {
    expectTypeOf<keyof Theme>().toEqualTypeOf<keyof UpstreamTheme>();

    const source = {
      colors: {
        primary: "blue",
        modes: { dark: { primary: "cyan" } }
      },
      space: [0, 4, 8],
      buttons: { primary: { px: [1, null, 2], bg: "primary" } }
    } satisfies Theme;
    const style = {
      variant: "buttons.primary",
      ":hover": { color: "primary" }
    } satisfies ThemeUIStyleObject;

    expectTypeOf(source).toMatchTypeOf<UpstreamTheme>();
    expectTypeOf(style).toMatchTypeOf<UpstreamStyle>();
  });

  it("restricts token leaves to the primitive values normalization supports", () => {
    expectTypeOf<ScalesAccepting<boolean>>().toBeNever();
    expectTypeOf<ScalesAccepting<() => string>>().toBeNever();
    expectTypeOf<{ colors: { primary: true } }>().not.toMatchTypeOf<Theme>();
    expectTypeOf<{
      colors: { modes: { dark: { primary: () => string } } };
    }>().not.toMatchTypeOf<Theme>();
    expectTypeOf<{
      fonts: { heading: { nested: false } };
    }>().not.toMatchTypeOf<Theme>();

    expect(() =>
      // @ts-expect-error Boolean leaves are rejected by normalization.
      normalizeTheme({ space: [true] })
    ).toThrow("Invalid Theme UI token: space.0");
    expect(() =>
      // @ts-expect-error Functions belong in styles, not token scales.
      normalizeTheme({ space: [() => 4] })
    ).toThrow("Invalid Theme UI token: space.0");

    const source = {
      colors: { primary: "var(--accent)" },
      fonts: { heading: "Custom Sans, sans-serif" },
      space: [0, 4, "0.5rem"],
      fontWeights: { regular: 400 },
      lineHeights: { body: 1.5 },
      opacities: { muted: 0.5 },
      buttons: { primary: { p: () => 2 } }
    } satisfies Theme;

    expectTypeOf(source).toMatchTypeOf<UpstreamTheme>();
    expect(normalizeTheme(source).tokens.space).toEqual({
      0: "0px",
      1: "4px",
      2: "0.5rem"
    });
  });
});
