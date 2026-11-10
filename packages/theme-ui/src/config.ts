import { defineRules } from "@mincho-js/css";
import type {
  CSSProperties,
  ResolveTheme,
  DefineRulesPropertyValuesEntry
} from "@mincho-js/css";

import {
  defaultBreakpoints,
  scaleProperties,
  shortcuts,
  breakpointEntries,
  breakpointQuery
} from "./scales.js";
import type { ScaleName } from "./scales.js";

type Variable = ResolveTheme<{ value: string }>["value"];

export interface VariableScale {
  readonly [key: string | number]:
    Variable | VariableScale | readonly Variable[];
}

export type ThemeUIScales = Partial<
  Record<ScaleName, VariableScale | readonly Variable[]>
>;

export type Breakpoints = Readonly<Record<string, string>> | readonly string[];

type ArrayConditionNames<
  B extends readonly string[],
  Index extends unknown[] = []
> = B extends readonly [string, ...infer Rest extends string[]]
  ? | (Index["length"] extends 0
        ? "sm"
        : Index["length"] extends 1
          ? "md"
          : Index["length"] extends 2
            ? "lg"
            : `bp${[...Index, unknown]["length"] & number}`)
    | ArrayConditionNames<Rest, [...Index, unknown]>
  : never;

type ConditionNames<B extends Breakpoints> = B extends readonly string[]
  ? number extends B["length"]
    ? "sm" | "md" | "lg" | `bp${number}`
    : ArrayConditionNames<B>
  : keyof B;

type NumericIndex<Key> = Key extends `${infer Index extends number}`
  ? Index
  : never;

type TokenKeys<T, Depth extends unknown[] = []> = Depth["length"] extends 8
  ? never
  : T extends readonly Variable[]
    ? | (number extends T["length"]
          ? number
          : NumericIndex<Extract<keyof T, `${number}`>>)
      | TokenKeys<Omit<T, keyof Variable[] | `${number}`>, [...Depth, unknown]>
    : {
        [K in keyof T & (string | number)]: T[K] extends Variable
          ? K
          : | `${K}.${TokenKeys<T[K], [...Depth, unknown]>}`
            | (T[K] extends { __default: Variable } ? K : never);
      }[keyof T & (string | number)];

type GlobalKeyword =
  "inherit" | "initial" | "unset" | "revert" | "revert-layer";

type NegativeKey<K> = K extends 0 | "0"
  ? never
  : K extends number
    ? `-${K}` extends `${infer N extends number}`
      ? N
      : never
    : K extends string
      ? K extends `-${string}`
        ? never
        : `-${K}`
      : never;

type SignedProperty =
  `margin${string}` | `inset${string}` | "top" | "right" | "bottom" | "left";

type ScaleProperty<S extends ScaleName> = (typeof scaleProperties)[S][number];

type PropertyScale<P> = {
  [S in ScaleName]: P extends ScaleProperty<S> ? S : never;
}[ScaleName];

type MappedProperty = ScaleProperty<ScaleName>;

export type ThemeUIProperties<V extends ThemeUIScales> = {
  [P in MappedProperty]: PropertyScale<P> extends keyof V
    ? | {
          [
            K in
              | TokenKeys<V[PropertyScale<P>]>
              | GlobalKeyword
              | (P extends SignedProperty
                  ? NegativeKey<TokenKeys<V[PropertyScale<P>]>>
                  : never)
          ]: CSSProperties[P];
        }
      | (undefined extends V[PropertyScale<P>] ? true : never)
    : true;
};

export type ThemeUIConditions<B extends Breakpoints> =
  B extends readonly string[]
    ? number extends B["length"]
      ? Partial<Record<ConditionNames<B>, { "@media": string }>>
      : Record<ConditionNames<B>, { "@media": string }>
    : {
        [K in keyof B]: string extends K
          ? { "@media": string } | undefined
          : { "@media": string };
      };

const globals = Object.fromEntries(
  ["inherit", "initial", "unset", "revert", "revert-layer"].map((key) => [
    key,
    key
  ])
);

function flattenScale(
  value: VariableScale | readonly Variable[],
  prefix = ""
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);

  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof entry === "string") result[path] = entry;
    else {
      if ("__default" in entry && typeof entry.__default === "string")
        result[path] = entry.__default;

      Object.assign(result, flattenScale(entry, path));
    }
  }

  return result;
}

/** Bind the shared Theme Spec to contract variables, independently of preset values. */
export type ThemeSpec<V extends ThemeUIScales, B extends Breakpoints> = {
  properties: ThemeUIProperties<V>;
  shortcuts: typeof shortcuts;
  conditions: ThemeUIConditions<B>;
  context: V;
};

export function themeSpec<const V extends ThemeUIScales>(
  vars: V
): ThemeSpec<V, typeof defaultBreakpoints>;
export function themeSpec<
  const V extends ThemeUIScales,
  const B extends Breakpoints | undefined
>(
  vars: V,
  breakpoints: B
): B extends Breakpoints
  ? ThemeSpec<V, B>
  : ThemeSpec<V, typeof defaultBreakpoints>;
export function themeSpec<
  const V extends ThemeUIScales,
  const B extends Breakpoints = typeof defaultBreakpoints
>(vars: V, breakpoints?: B): ThemeSpec<V, B> {
  const entries = Object.entries(
    scaleProperties
  ).flatMap<DefineRulesPropertyValuesEntry>(([scale, properties]) => {
    const values = vars[scale as ScaleName];

    if (!values) return [{ source: true, properties }];

    const tokens = flattenScale(values);
    const positive = { ...globals, ...tokens };
    const negative = { ...positive };

    for (const [key, value] of Object.entries(tokens)) {
      if (
        key !== "0" &&
        !key.startsWith("-") &&
        !Object.hasOwn(tokens, `-${key}`)
      )
        negative[`-${key}`] = `calc(${value} * -1)`;
    }

    return properties.map((property) => ({
      source: /^(margin|inset)|^(top|right|bottom|left)$/.test(property)
        ? negative
        : positive,
      properties: [property]
    }));
  });

  const conditions = Object.fromEntries(
    breakpointEntries(breakpoints ?? defaultBreakpoints).map(
      ([name, value]) => {
        return [
          name,
          {
            "@media": breakpointQuery(value)
          }
        ];
      }
    )
  ) as ThemeUIConditions<B>;

  return {
    properties: defineRules.propertyValues(entries) as ThemeUIProperties<V>,
    shortcuts,
    conditions,
    context: vars
  };
}
