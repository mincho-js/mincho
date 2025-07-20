import type { CSSRule } from "@mincho-js/transform-to-vanilla";
import type { Resolve } from "../types.js";

type IsOptional<T, K extends keyof T> =
  Record<string, never> extends Pick<T, K> ? true : false;
type IsRequired<T, K extends keyof T> =
  IsOptional<T, K> extends true ? false : true;

export type RestrictCSSRule<T extends CSSRule> = {
  [K in keyof T as T[K] extends false ? never : K]: T[K] extends true
    ? K extends keyof CSSRule
      ? NonNullable<CSSRule[K]>
      : never
    : T[K];
} extends infer U
  ? Resolve<
      {
        [K in keyof U as IsRequired<U, K> extends true ? K : never]-?: U[K];
      } & {
        [K in keyof U as IsOptional<U, K> extends true ? K : never]?: U[K];
      }
    >
  : never;
