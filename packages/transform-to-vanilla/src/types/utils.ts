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

// == Object ==================================================================
export type PartialDeepMerge<T, U> = {
  [P in keyof T | keyof U]?: P extends keyof T & keyof U
    ? T[P] extends object
      ? U[P] extends object
        ? PartialDeepMerge<T[P], U[P]> // Both are objects, merge recursively
        : T[P] | U[P] // One is an object, one is not, use union
      : T[P] | U[P] // At least one is not an object, use union
    : P extends keyof T
      ? T[P] // Exists only in T
      : P extends keyof U
        ? U[P] // Exists only in U
        : never;
};

// == Spread ==================================================================
// https://stackoverflow.com/questions/49682569/typescript-merge-object-types
export type Spread<A extends readonly [...unknown[]]> = A extends [
  infer L,
  ...infer R
]
  ? SpreadTwo<L, Spread<R>>
  : unknown;

type SpreadTwo<L, R> = Id<
  Pick<L, Exclude<keyof L, keyof R>> &
    Pick<R, Exclude<keyof R, OptionalPropertyNames<R>>> &
    Pick<R, Exclude<OptionalPropertyNames<R>, keyof L>> &
    SpreadProperties<L, R, OptionalPropertyNames<R> & keyof L>
>;

type Id<T> = T extends infer U ? { [K in keyof U]: U[K] } : never;

type SpreadProperties<L, R, K extends keyof L & keyof R> = {
  [P in K]: L[P] | Exclude<R[P], undefined>;
};

type OptionalPropertyNames<T> = {
  [K in keyof T]-?: object extends { [P in K]: T[K] } ? K : never;
}[keyof T];

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

    it("DeepMerge<T, U>", () => {
      expectTypeOf<
        PartialDeepMerge<{ a: number; b: boolean }, { a: string | boolean }>
      >().toEqualTypeOf<{
        a?: number | string | boolean;
        b?: boolean;
      }>();
      expectTypeOf<
        PartialDeepMerge<
          { a: { b: number; c: boolean } },
          { a: { b: string | boolean } }
        >
      >().toEqualTypeOf<{
        a?: { b?: number | string | boolean; c?: boolean };
      }>();
      expectTypeOf<
        PartialDeepMerge<{ a: number; b: boolean }, { a: { b: string } }>
      >().toEqualTypeOf<{ a?: number | { b: string }; b?: boolean }>();
      expectTypeOf<
        PartialDeepMerge<
          { a: number | string[]; b: boolean },
          { a: { b: string } | boolean[] }
        >
      >().toEqualTypeOf<{
        a?: number | string[] | { b: string } | boolean[];
        b?: boolean;
      }>();
    });

    it("Spread<[T, U]>", () => {
      expectTypeOf<
        Spread<[{ a: number; b: boolean }, { a: string | boolean }]>
      >().toEqualTypeOf<{
        a: string | boolean;
        b: boolean;
      }>();
      expectTypeOf<
        Spread<
          [{ a: { b: number; c: boolean } }, { a: { b: string | boolean } }]
        >
      >().toEqualTypeOf<{
        a: { b: string | boolean };
      }>();
      expectTypeOf<
        Spread<[{ a: number; b: boolean }, { a: { b: string } }]>
      >().toEqualTypeOf<{ a: { b: string }; b: boolean }>();
    });
  });
}
