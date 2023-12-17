// == Interface ================================================================
export type NonNullableString = string & NonNullable<unknown>;

export type ToKebabCase<
  InputString extends string,
  AccumulatorString extends string = ""
> = InputString extends `${infer FirstChar}${infer RemainingString}`
  ? ToKebabCase<
      RemainingString,
      `${AccumulatorString}${FirstChar extends Lowercase<FirstChar>
        ? ""
        : "-"}${Lowercase<FirstChar>}`
    >
  : AccumulatorString;

export type FromKebabCase<InputString extends string> =
  InputString extends `${infer BeforeString}-${infer AfterString}`
    ? `${BeforeString}${Capitalize<FromKebabCase<AfterString>>}`
    : InputString;

export type ColonToSnake<InputString extends string> =
  InputString extends `${infer BeforeString}:${infer AfterString}`
    ? `${BeforeString}_${ColonToSnake<AfterString>}`
    : InputString;

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expectTypeOf } = import.meta.vitest;

  describe.concurrent("String type utils", () => {
    it("Convert to kebab", () => {
      type CamelCase = ToKebabCase<"backgroundColor">;
      expectTypeOf<CamelCase>().toEqualTypeOf<"background-color">();

      type PascalCase = ToKebabCase<"WebkitTapHighlightColor">;
      expectTypeOf<PascalCase>().toEqualTypeOf<"-webkit-tap-highlight-color">();
    });

    it("Convert from kebab", () => {
      type CamelCase = FromKebabCase<"background-color">;
      expectTypeOf<CamelCase>().toEqualTypeOf<"backgroundColor">();

      type PascalCase = FromKebabCase<"-webkit-tap-highlight-color">;
      expectTypeOf<PascalCase>().toEqualTypeOf<"WebkitTapHighlightColor">();
    });

    it("Convert colon to snake", () => {
      type SimplePseudo = ColonToSnake<":hover">;
      expectTypeOf<SimplePseudo>().toEqualTypeOf<"_hover">();

      type DoubleSimplePseudo = ColonToSnake<"::before">;
      expectTypeOf<DoubleSimplePseudo>().toEqualTypeOf<"__before">();
    });
  });
}
