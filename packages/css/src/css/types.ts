import type { CSSRule } from "@mincho-js/transform-to-vanilla";
import type { Resolve } from "../types.js";

type IsOptional<T, K extends keyof T> =
  Record<string, never> extends Pick<T, K> ? true : false;
type IsRequired<T, K extends keyof T> =
  IsOptional<T, K> extends true ? false : true;

export type CSSRuleWith<T extends CSSRule> = {
  [K in keyof T as T[K] extends false ? never : K]: true extends T[K]
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

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, assertType } = import.meta.vitest;

  describe.concurrent("CSSRuleWith Type Test", () => {
    function assertCssRuleWith<const T extends CSSRule>(
      variants: CSSRuleWith<T>
    ) {
      assertType<CSSRuleWith<T>>(variants);
      return variants;
    }

    it("Common CSSRuleWith Type", () => {
      assertCssRuleWith({
        color: "red",
        // @ts-expect-error: `size` is not css property.
        size: "small"
      });
    });

    it("Based on CSSRule Type", () => {
      type TestRule = {
        color: true;
        background?: true;
      };

      assertCssRuleWith<TestRule>({
        color: "red"
        // background is optional
      });
      assertCssRuleWith<TestRule>({
        color: "red",
        background: "blue"
      });

      // @ts-expect-error: `color` is required.
      assertCssRuleWith<TestRule>({
        background: "blue"
      });
      assertCssRuleWith<TestRule>({
        color: "red",
        // @ts-expect-error: backgroundColor is not included in the type.
        backgroundColor: "blue"
      });
    });

    it("Custom RuleWith Type", () => {
      type TestRule = {
        color: true;
        size: "medium" | "large";
        variant?: "outlined" | "filled";
      };

      assertCssRuleWith<TestRule>({
        color: "red",
        size: "medium"
      });
      assertCssRuleWith<TestRule>({
        color: "red",
        size: "medium",
        variant: "outlined"
      });

      // @ts-expect-error: `size` is required.
      assertCssRuleWith<TestRule>({
        color: "red"
      });
      assertCssRuleWith<TestRule>({
        color: "red",
        // @ts-expect-error: small is not included in `size` key.
        size: "small"
      });
      assertCssRuleWith<TestRule>({
        color: "red",
        size: "medium",
        // @ts-expect-error: `variant` only accepts "outlined" | "filled".
        variant: "ghost"
      });
    });
  });
}
