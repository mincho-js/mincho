/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  PureCSSVarFunction,
  NonNullableString
} from "@mincho-js/transform-to-vanilla";
import type { Resolve } from "../types.js";

export interface Theme {
  [tokenName: string]: TokenValue | Theme;
}

export type ThemeValue =
  | { get(): TokenPrimitiveValue }
  | TokenPrimitiveValue
  | TokenPrimitiveValue[]
  | TokenCompositeValue
  | TokenAllDefinition;

/**
 * Based on W3C Design Tokens Community Group
 * @see https://www.w3.org/community/design-tokens/
 * @see https://www.designtokens.org/tr/drafts/format/
 **/
export type TokenAllDefinition =
  | TokenOtherDefinition
  | TokenColorDefinition
  | TokenDimensionDefinition
  | TokenFontFamilyDefinition
  | TokenFontWeightDefinition
  | TokenDurationDefinition
  | TokenCubicBezierDefinition
  | TokenNumberDefinition;

export interface TokenDefinition {
  $type: string;
  $value: TokenValue;
  $description?: string;
}

interface TokenDefinitionBase<TokenType, TokenValue> {
  $type: TokenType;
  $value: TokenValue;
  $description?: string;
}
export interface TokenOtherDefinition extends TokenDefinitionBase<
  NonNullableString,
  TokenValue
> {}

export interface TokenColorDefinition extends TokenDefinitionBase<
  "color",
  string | TokenColorValue
> {}
export interface TokenColorValue {
  /**
   * A string that specifies the color space or color model
   */
  colorSpace: string;
  /**
   * An array representing the color components. The number of components depends on the color space.
   */
  components: ColorComponentValue[];
  /**
   * number that represents the alpha value of the color. This value is between 0 and 1, where 0 is fully transparent and 1 is fully opaque. If omitted, the alpha value of the color MUST be assumed to be 1 (fully opaque).
   */
  alpha?: number;
  /**
   * A string that represents a fallback value of the color. The fallback color MUST be formatted in 6 digit CSS hex color notation format to avoid conflicts with the provided alpha value.
   */
  hex?: string;
}
type ColorComponentValue = number | "none";

export interface TokenDimensionDefinition extends TokenDefinitionBase<
  "dimension",
  TokenDimensionValue
> {}
export interface TokenDimensionValue {
  /**
   * An integer or floating-point value representing the numeric value.
   */
  value: number;
  /**
   * Unit of distance. Supported values: "px", "rem".
   */
  unit: string;
}

export interface TokenFontFamilyDefinition extends TokenDefinitionBase<
  "fontFamily",
  TokenFontFamilyValue
> {}
export type TokenFontFamilyValue = string | string[];

export interface TokenFontWeightDefinition extends TokenDefinitionBase<
  "fontWeight",
  TokenFontWeightValue
> {}
export type TokenFontWeightValue =
  | number
  // 100
  | "thin"
  | "hairline"
  // 200
  | "extra-light"
  | "ultra-light"
  // 300
  | "light"
  // 400
  | "normal"
  | "regular"
  | "book"
  // 500
  | "medium"
  // 600
  | "semi-bold"
  | "demi-bold"
  // 700
  | "bold"
  // 800
  | "extra-bold"
  | "ultra-bold"
  // 900
  | "black"
  | "heavy"
  // 950
  | "extra-black"
  | "ultra-black";

export interface TokenDurationDefinition extends TokenDefinitionBase<
  "duration",
  TokenDurationValue
> {}
export interface TokenDurationValue {
  /**
   * An integer or floating-point value representing the numeric value.
   */
  value: number;
  /**
   * Unit of time. Supported values: "ms"(milliseconds), "s"(seconds).
   */
  unit: string;
}

export interface TokenCubicBezierDefinition extends TokenDefinitionBase<
  "cubicBezier",
  TokenCubicBezierValue
> {}
type TokenCubicBezierValue = [number, number, number, number];

export interface TokenNumberDefinition extends TokenDefinitionBase<
  "number",
  number
> {}

export type TokenValue = TokenLeafValue | TokenCompositeValue;
export interface TokenCompositeValue {
  get resolved(): TokenValue;
  [property: string]: TokenValue;
}
export type TokenLeafValue = TokenAtomicValue | TokenAtomicValue[];
export type TokenAtomicValue =
  // | TokenReferencedValue // Referenced value may replaced via getter with `this`
  TokenPrimitiveValue | TokenDimensionValue;

export type TokenPrimitiveValue = string | number | boolean | undefined;

// export type TokenReferencedValue = `${string}{${string}}${string}`;

export type ResolveTheme<T extends Theme> = {
  -readonly [K in keyof T]: T[K] extends ThemeValue
    ? ResolveThemeValue<T[K]>
    : T[K] extends Theme
      ? Resolve<ResolveTheme<T[K]>>
      : never;
};

export type ResolveThemeValue<T extends ThemeValue> = T extends TokenDefinition
  ? ResolveTokenValue<T["$value"]>
  : T extends TokenAllDefinition
    ? PureCSSVarFunction
    : T extends TokenPrimitiveValue
      ? PureCSSVarFunction
      : T extends TokenPrimitiveValue[]
        ? PureCSSVarFunction[]
        : T extends TokenCompositeValue
          ? ResolveCompositeValue<T>
          : never;

export type ResolveTokenValue<T extends TokenValue> =
  T extends TokenCompositeValue
    ? ResolveCompositeValue<T>
    : T extends TokenDimensionValue | TokenPrimitiveValue
      ? PureCSSVarFunction
      : T extends (infer U)[]
        ? U extends TokenAtomicValue
          ? PureCSSVarFunction[]
          : never
        : never;
type ResolveCompositeValue<T extends TokenCompositeValue> = Resolve<
  { resolved: PureCSSVarFunction } & {
    [K in Exclude<keyof T, "resolved">]: PureCSSVarFunction;
  }
>;

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, assertType, expectTypeOf } = import.meta.vitest;

  function compositeValue<ComposedValue>(
    value: ComposedValue & ThisType<ComposedValue>
  ): ComposedValue {
    return value;
  }

  function createBoxShadowResolver() {
    return function (this: {
      color: string;
      offsetX: TokenDimensionValue;
      offsetY: TokenDimensionValue;
      blur: TokenDimensionValue;
      spread: TokenDimensionValue;
    }) {
      const { color, offsetX, offsetY, blur, spread } = this;
      const offsetXValue = `${offsetX.value}${offsetX.unit}`;
      const offsetYValue = `${offsetY.value}${offsetY.unit}`;
      const blurValue = `${blur.value}${blur.unit}`;
      const spreadValue =
        spread.value === 0 ? "" : ` ${spread.value}${spread.unit}`;
      return `${color} ${offsetXValue} ${offsetYValue} ${blurValue}${spreadValue}`;
    };
  }

  describe.concurrent("Theme Type Test", () => {
    it("Token Value Types", () => {
      // TokenPrimitiveValue
      assertType<TokenPrimitiveValue>("string");
      assertType<TokenPrimitiveValue>(123);
      assertType<TokenPrimitiveValue>(true);
      assertType<TokenPrimitiveValue>(undefined);

      // TokenUnitValue
      assertType<TokenDimensionValue>({ value: 12, unit: "px" });

      // TokenReferencedValue
      // assertType<TokenReferencedValue>("{colors.primary}");

      // TokenComposedValue
      assertType<TokenCompositeValue>(
        compositeValue({
          get resolved() {
            const { color, offsetX, offsetY, blur, spread } = this;
            const offsetXValue = `${offsetX.value}${offsetX.unit}`;
            const offsetYValue = `${offsetY.value}${offsetY.unit}`;
            const blurValue = `${blur.value}${blur.unit}`;
            const spreadValue =
              spread.value === 0 ? "" : ` ${spread.value}${spread.unit}`;
            return `${color} ${offsetXValue} ${offsetYValue} ${blurValue}${spreadValue}`;
          },
          color: "#00000080",
          offsetX: { value: 0.5, unit: "rem" },
          offsetY: { value: 0.5, unit: "rem" },
          blur: { value: 1.5, unit: "rem" },
          spread: { value: 0, unit: "rem" }
        })
      );

      // TokenDefinition
      assertType<TokenDefinition>({
        $type: "color",
        $value: "#ff0000"
      });
      assertType<TokenDefinition>({
        $type: "boxShadow",
        $value: compositeValue({
          get resolved() {
            return createBoxShadowResolver().call(this);
          },
          color: "#00000080",
          offsetX: { value: 0.5, unit: "rem" },
          offsetY: { value: 0.5, unit: "rem" },
          blur: { value: 1.5, unit: "rem" },
          spread: { value: 0, unit: "rem" }
        })
      });
    });

    it("matches specialized token definition variants", () => {
      const colorValue: TokenColorValue = {
        colorSpace: "srgb",
        components: [255, 0, 0],
        alpha: 1,
        hex: "#ff0000"
      };
      const colorDefinition = {
        $type: "color",
        $value: colorValue,
        $description: "red"
      } as const satisfies TokenColorDefinition;

      const dimensionValue: TokenDimensionValue = { value: 4, unit: "px" };
      const dimensionDefinition = {
        $type: "dimension",
        $value: dimensionValue
      } as const satisfies TokenDimensionDefinition;

      const fontFamilyDefinition = {
        $type: "fontFamily",
        $value: ["Inter", "sans-serif"]
      } as const satisfies TokenFontFamilyDefinition;

      const fontWeightDefinition = {
        $type: "fontWeight",
        $value: "semi-bold"
      } as const satisfies TokenFontWeightDefinition;

      const durationValue: TokenDurationValue = { value: 250, unit: "ms" };
      const durationDefinition = {
        $type: "duration",
        $value: durationValue
      } as const satisfies TokenDurationDefinition;

      const cubicBezierDefinition = {
        $type: "cubicBezier",
        $value: [0.25, 0.1, 0.25, 1]
      } as const satisfies TokenCubicBezierDefinition;

      const numberDefinition = {
        $type: "number",
        $value: 1.618
      } as const satisfies TokenNumberDefinition;

      expectTypeOf(colorDefinition).toExtend<TokenAllDefinition>();
      expectTypeOf(dimensionDefinition).toExtend<TokenAllDefinition>();
      expectTypeOf(fontFamilyDefinition).toExtend<TokenAllDefinition>();
      expectTypeOf(fontWeightDefinition).toExtend<TokenAllDefinition>();
      expectTypeOf(durationDefinition).toExtend<TokenAllDefinition>();
      expectTypeOf(cubicBezierDefinition).toExtend<TokenAllDefinition>();
      expectTypeOf(numberDefinition).toExtend<TokenAllDefinition>();
    });

    it("Theme Type", () => {
      const myTheme = compositeValue({
        color: {
          base: {
            red: {
              $type: "color",
              $value: {
                colorSpace: "srgb",
                components: [255, 0, 0],
                alpha: 1,
                hex: "#ff0000"
              }
            },
            green: "#00ff00",
            blue: "#0000ff"
          },
          semantic: {
            primary: "#0000ff",
            secondary: "#00ff00",
            get error() {
              return this.color.base.red;
            }
          }
        },
        space: [2, 4, 8, 16, 32, 64],
        shadow: {
          light: compositeValue({
            get resolved() {
              return createBoxShadowResolver().call(this);
            },
            color: "#00000080",
            offsetX: { value: 0.5, unit: "rem" },
            offsetY: { value: 0.5, unit: "rem" },
            blur: { value: 1.5, unit: "rem" },
            spread: { value: 0, unit: "rem" }
          }),
          heavy: compositeValue({
            get resolved() {
              return createBoxShadowResolver().call(this);
            },
            color: "#000000cc",
            offsetX: { value: 1, unit: "rem" },
            offsetY: { value: 1, unit: "rem" },
            blur: { value: 3, unit: "rem" },
            spread: { value: 0, unit: "rem" }
          })
        }
      });

      assertType<Theme>(myTheme);
      // use branded for MISMATCH error: https://github.com/vitest-dev/vitest/issues/4114
      expectTypeOf<ResolveTheme<typeof myTheme>>().branded.toEqualTypeOf<{
        color: {
          base: {
            red: PureCSSVarFunction;
            green: PureCSSVarFunction;
            blue: PureCSSVarFunction;
          };
          semantic: {
            primary: PureCSSVarFunction;
            secondary: PureCSSVarFunction;
            error: PureCSSVarFunction;
          };
        };
        space: PureCSSVarFunction[];
        shadow: {
          light: {
            readonly resolved: PureCSSVarFunction;
            color: PureCSSVarFunction;
            offsetX: PureCSSVarFunction;
            offsetY: PureCSSVarFunction;
            blur: PureCSSVarFunction;
            spread: PureCSSVarFunction;
          };
          heavy: {
            readonly resolved: PureCSSVarFunction;
            color: PureCSSVarFunction;
            offsetX: PureCSSVarFunction;
            offsetY: PureCSSVarFunction;
            blur: PureCSSVarFunction;
            spread: PureCSSVarFunction;
          };
        };
      }>();
    });
  });
}
