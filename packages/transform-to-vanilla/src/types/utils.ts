// == Numbers =================================================================
// https://stackoverflow.com/questions/39494689/is-it-possible-to-restrict-number-to-a-certain-range
export type IntRange<F extends number, T extends number> =
  | Exclude<Enumerate<T>, Enumerate<F>>
  | T;

export type Enumerate<
  N extends number,
  Acc extends number[] = []
> = Acc["length"] extends N
  ? Acc[number]
  : Enumerate<N, [...Acc, Acc["length"]]>;

// == Array ===================================================================
export type ExcludeArray<T> = T extends unknown[] ? never : T;

export type Arr<
  T,
  N extends number,
  Acc extends T[] = []
> = Acc["length"] extends N ? Acc : Arr<T, N, [...Acc, T]>;

// == Test ====================================================================
if (import.meta.vitest) {
  const { describe, it, expectTypeOf } = import.meta.vitest;

  describe.concurrent("Type utils", () => {
    it("IntRage<F, T>", () => {
      expectTypeOf<IntRange<0, 0>>().toEqualTypeOf<0>();
      expectTypeOf<IntRange<0, 1>>().toEqualTypeOf<0 | 1>();
      expectTypeOf<IntRange<0, 3>>().toEqualTypeOf<0 | 1 | 2 | 3>();
      expectTypeOf<IntRange<5, 10>>().toEqualTypeOf<5 | 6 | 7 | 8 | 9 | 10>();
    });

    it("Enumerate<T, Acc>", () => {
      expectTypeOf<Enumerate<0>>().toEqualTypeOf<never>();
      expectTypeOf<Enumerate<1>>().toEqualTypeOf<0>();
      expectTypeOf<Enumerate<3>>().toEqualTypeOf<0 | 1 | 2>();
      expectTypeOf<Enumerate<5>>().toEqualTypeOf<0 | 1 | 2 | 3 | 4>();
    });

    it("ExcludeArray<T>", () => {
      expectTypeOf<ExcludeArray<string | string[]>>().toEqualTypeOf<string>();
      expectTypeOf<ExcludeArray<string | number[]>>().toEqualTypeOf<string>();
      expectTypeOf<ExcludeArray<boolean | number | number[]>>().toEqualTypeOf<
        boolean | number
      >();
    });

    it("Arr<T, N, Acc>", () => {
      expectTypeOf<Arr<number, 1>>().toEqualTypeOf<[number]>();
      expectTypeOf<Arr<number, 2>>().toEqualTypeOf<[number, number]>();
      expectTypeOf<Arr<number, 5>>().toEqualTypeOf<
        [number, number, number, number, number]
      >();
      expectTypeOf<Arr<number | string, 2>>().toEqualTypeOf<
        [number | string, number | string]
      >();
    });
  });
}