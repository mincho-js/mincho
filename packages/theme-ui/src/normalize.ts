import type { Theme as MinchoTheme } from "@mincho-js/css";

import type { Theme } from "./schema.js";
import { scaleProperties } from "./scales.js";
import type { ScaleName } from "./scales.js";

// Theme UI's css() supplies these scales when the theme omits them.
export const defaultScales = {
  space: [0, 4, 8, 16, 32, 64, 128, 256, 512],
  fontSizes: [12, 14, 16, 20, 24, 32, 48, 64, 72]
} as const;

const lengthScales = [
  "space",
  "fontSizes",
  "letterSpacings",
  "sizes",
  "borderWidths",
  "radii"
] as const;

type Field<T, Key extends PropertyKey> = T extends unknown
  ? Key extends keyof T
    ? T[Key]
    : never
  : never;

type ColorModes<P extends Theme> = NonNullable<
  Field<NonNullable<Field<P, "colors">>, "modes">
>;

export type ColorModeNames<P extends Theme> = Extract<
  UnionKeys<ColorModes<P>>,
  string | number
>;

type RequiredModes<P extends Theme> = {
  [Mode in ColorModeNames<P>]: string extends Mode
    ? never
    : number extends Mode
      ? never
      : [P] extends [{ colors: { modes: Record<Mode, unknown> } }]
        ? Mode
        : never;
}[ColorModeNames<P>];

type LengthScale = (typeof lengthScales)[number];

type Index<K> = K extends `${infer N extends number}`
  ? number extends N
    ? K
    : N
  : K;

type ArrayKeys<T extends readonly unknown[]> =
  | Exclude<Extract<keyof T, string>, keyof unknown[]>
  | (number extends T["length"] ? number : never);

type Normalize<T, S> = T extends undefined
  ? undefined
  : T extends string | number
    ? S extends LengthScale
      ? string
      : T
    : T extends readonly unknown[]
      ? {
          -readonly [
            K in keyof T as K extends ArrayKeys<T> ? Index<K> : never
          ]: Normalize<T[K], S>;
        }
      : { -readonly [K in keyof T]: Normalize<T[K], S> };

// Each source replaces its defaults; omitted optional scales keep a fallback.
type EffectiveScales<T> = T extends unknown
  ? Omit<typeof defaultScales, keyof T> & {
      [K in keyof T]: K extends keyof typeof defaultScales
        ? Record<never, never> extends Pick<T, K>
          ? T[K] | (typeof defaultScales)[K]
          : T[K]
        : T[K];
    }
  : never;

type OptionalColors<T> = T extends object
  ? { [K in keyof T]?: OptionalColors<T[K]> }
  : T;

// A source union contains alternatives; separate modes are collected together.
type ColorSource<T> =
  | Extract<T, string | undefined>
  | ([Exclude<T, string | undefined>] extends [never]
      ? never
      : {
          [K in UnionKeys<Exclude<T, string | undefined>>]: [T] extends [
            Record<K, unknown>
          ]
            ? ColorSource<UnionValue<T, K>>
            : OptionalColors<ColorSource<UnionValue<T, K>>> | undefined;
        });

type BaseColors<T> = T extends unknown ? Omit<T, "modes"> : never;

type ModeColorShapes<T extends Theme> = {
  [Mode in ColorModeNames<T>]: Mode extends RequiredModes<T>
    ? ColorSource<Field<ColorModes<T>, Mode>>
    : OptionalColors<ColorSource<Field<ColorModes<T>, Mode>>>;
}[ColorModeNames<T>];

type ColorShapes<T extends Theme> =
  ColorSource<BaseColors<NonNullable<T["colors"]>>> | ModeColorShapes<T>;

type UnionKeys<T> = T extends readonly unknown[]
  ? ArrayKeys<T>
  : T extends unknown
    ? keyof T
    : never;

type UnionValue<T, K> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : never
  : never;

type RequiredColorKeys<T> = T extends unknown
  ? {
      [K in UnionKeys<T>]: undefined extends UnionValue<T, K> ? never : K;
    }[UnionKeys<T>]
  : never;

type ColorValue<T> =
  | (Extract<T, string> extends never ? never : string)
  | ([Exclude<T, string>] extends [never]
      ? never
      : ColorTokens<Exclude<T, string>>);

type ColorTokens<T> = {
  [
    K in UnionKeys<T> as K extends RequiredColorKeys<T> ? Index<K> : never
  ]: ColorValue<NonNullable<UnionValue<T, K>>>;
} & {
  [
    K in UnionKeys<T> as K extends RequiredColorKeys<T> ? never : Index<K>
  ]?: ColorValue<NonNullable<UnionValue<T, K>>>;
};

type PreparedScale<T extends Theme, S, Value> = Value extends undefined
  ? undefined
  : S extends "colors"
    ? ColorTokens<ColorShapes<T>>
    : Normalize<Value, S>;

/** Mincho tokens preserve the presence of the original scales and defaults. */
export type NormalizedTokens<T extends Theme> = T extends unknown
  ? {
      [
        S in keyof EffectiveScales<T> as S extends ScaleName ? S : never
      ]: PreparedScale<T, S, EffectiveScales<T>[S]>;
    }
  : never;

export interface NormalizedTheme<T extends Theme> {
  tokens: NormalizedTokens<T>;
  modes: Partial<Record<ColorModeNames<T>, NormalizedTokens<T>>> &
    Record<RequiredModes<T>, NormalizedTokens<T>>;
}

function normalize(
  value: unknown,
  scale: string,
  path: string
): MinchoTheme[string] {
  if (typeof value === "string") return value;
  if (typeof value === "number")
    return (lengthScales as readonly string[]).includes(scale)
      ? `${value}px`
      : value;
  if (!value || typeof value !== "object")
    throw new Error(`Invalid Theme UI token: ${path}`);

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, normalize(entry, scale, `${path}.${key}`)])
  );
}

function mergeColors(
  base: Record<string, unknown>,
  mode: Record<string, unknown>,
  path: string
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.assign(
    Object.create(null),
    base
  );

  for (const [key, value] of Object.entries(mode)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(base, key))
      throw new Error(
        `Color mode must use an existing color token: ${path}.${key}`
      );

    const previous = base[key];

    if (
      previous &&
      typeof previous === "object" &&
      value &&
      typeof value === "object"
    )
      result[key] = mergeColors(
        previous as Record<string, unknown>,
        value as Record<string, unknown>,
        `${path}.${key}`
      );
    else if (typeof previous !== typeof value)
      throw new Error(`Color mode changes the token shape: ${path}.${key}`);
    else result[key] = value;
  }

  return result;
}

function collectColors(
  base: Record<string, unknown>,
  mode: Record<string, unknown>,
  path: string
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.assign(
    Object.create(null),
    base
  );

  for (const [key, value] of Object.entries(mode)) {
    if (value === undefined) continue;

    const previous = Object.hasOwn(base, key) ? base[key] : undefined;

    if (value && typeof value === "object") {
      if (
        previous !== undefined &&
        (typeof previous !== "object" || previous === null)
      )
        throw new Error(`Color mode changes the token shape: ${path}.${key}`);

      result[key] = collectColors(
        (previous ?? {}) as Record<string, unknown>,
        value as Record<string, unknown>,
        `${path}.${key}`
      );
    } else if (previous === undefined) {
      // An undefined custom property has CSS's initial value in other modes.
      result[key] = "initial";
    } else if (typeof previous !== typeof value) {
      throw new Error(`Color mode changes the token shape: ${path}.${key}`);
    }
  }

  return result;
}

/** Normalize values at the compilation boundary; the source theme is never mutated. */
export function normalizeTheme<const T extends Theme>(
  source: T
): NormalizedTheme<T> {
  const effective = { ...defaultScales, ...source };
  const { modes = {}, ...colors } = source.colors ?? {};
  const modeEntries = Object.entries(modes).filter(
    ([, mode]) => mode !== undefined
  );
  let completeColors: Record<string, unknown> = colors;

  for (const [name, mode] of modeEntries)
    completeColors = collectColors(
      completeColors,
      mode,
      `colors.modes.${name}`
    );

  const tokens: MinchoTheme = {};

  for (const scale of Object.keys(scaleProperties) as ScaleName[]) {
    const value =
      scale === "colors" ? source.colors && completeColors : effective[scale];

    if (value !== undefined) tokens[scale] = normalize(value, scale, scale);
  }

  return {
    tokens,
    modes: Object.fromEntries(
      modeEntries.map(([name, mode]) => [
        name,
        {
          ...tokens,
          colors: normalize(
            mergeColors(completeColors, mode, `colors.modes.${name}`),
            "colors",
            "colors"
          )
        }
      ])
    )
  } as NormalizedTheme<T>;
}
