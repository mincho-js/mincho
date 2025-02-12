import type {
  VariantGroups,
  VariantDefinitions,
  ToggleVariantMap,
  VariantSelection,
  VariantObjectSelection
} from "./types";
import type { ComplexCSSRule } from "@mincho-js/transform-to-vanilla";
import { css } from "../css";

export function mapValues<Input extends Record<string, unknown>, OutputValue>(
  input: Input,
  fn: (value: Input[keyof Input], key: keyof Input) => OutputValue
): Record<keyof Input, OutputValue> {
  const result = {} as Record<keyof Input, OutputValue>;

  for (const key in input) {
    result[key] = fn(input[key], key);
  }

  return result;
}

export function processCompoundStyle(
  style: ComplexCSSRule | string,
  debugId: string | undefined,
  index: number
): string {
  return typeof style === "string"
    ? style
    : css(style, `${debugId}_compound_${index}`);
}

export function transformVariantSelection<Variants extends VariantGroups>(
  variants?: VariantSelection<Variants> | undefined
): VariantObjectSelection<Variants>;
export function transformVariantSelection<
  Variants extends VariantGroups,
  ToggleVariants extends VariantDefinitions
>(
  variants?:
    | VariantSelection<Variants & ToggleVariantMap<ToggleVariants>>
    | undefined
): VariantObjectSelection<Variants & ToggleVariantMap<ToggleVariants>>;
export function transformVariantSelection<
  Variants extends VariantGroups,
  ToggleVariants extends VariantDefinitions
>(
  variants?:
    | VariantSelection<Variants & ToggleVariantMap<ToggleVariants>>
    | undefined
): VariantObjectSelection<Variants & ToggleVariantMap<ToggleVariants>> {
  if (Array.isArray(variants)) {
    return variants.reduce<
      VariantObjectSelection<Variants & ToggleVariantMap<ToggleVariants>> & {
        [key: string]: boolean | string;
      }
    >((acc, variant) => {
      if (typeof variant === "string") {
        // @ts-expect-error - https://github.com/mincho-js/mincho/pull/110#discussion_r1780050654
        acc[variant] = true;
      } else {
        Object.assign(
          acc,
          variant as VariantObjectSelection<
            Variants & ToggleVariantMap<ToggleVariants>
          >
        );
      }

      return acc;
    }, {});
  }

  return variants ?? {};
}

export function transformToggleVariants<
  ToggleVariants extends VariantDefinitions
>(toggleVariants: ToggleVariants): ToggleVariantMap<ToggleVariants> {
  const variants: Partial<ToggleVariantMap<ToggleVariants>> = {};

  for (const variantsName in toggleVariants) {
    const variantsStyle = toggleVariants[variantsName];
    variants[variantsName] = {
      true: variantsStyle
    };
  }

  return variants as ToggleVariantMap<ToggleVariants>;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  describe("mapValues", () => {
    it("should transform values of an object", () => {
      const input = { a: 1, b: 2, c: 3 };
      const result = mapValues(input, (value) => value * 2);
      expect(result).toEqual({ a: 2, b: 4, c: 6 });
    });

    it("should handle empty objects", () => {
      const input = {};
      const result = mapValues(input, (value) => value);
      expect(result).toEqual({});
    });

    it("should handle objects with string values", () => {
      const input = { name: "John", surname: "Doe" };
      const result = mapValues(input, (value) => value.toUpperCase());
      expect(result).toEqual({ name: "JOHN", surname: "DOE" });
    });

    it("should provide correct key in the callback", () => {
      const input = { x: 10, y: 20 };
      const result = mapValues(input, (value, key) => `${key}:${value}`);
      expect(result).toEqual({ x: "x:10", y: "y:20" });
    });

    it("should handle objects with mixed value types", () => {
      const input = { a: 1, b: "two", c: true };
      const result = mapValues(input, (value) => typeof value);
      expect(result).toEqual({ a: "number", b: "string", c: "boolean" });
    });
  });

  describe("transformVariantSelection", () => {
    type ExampleVariant = {
      disabled: {
        true: string;
      };
      rounded: {
        true: string;
      };
      outlined: {
        true: string;
        false: string;
      };
      color: {
        primary: string;
        secondary: string;
        tertiary: string;
      };
      size: {
        large: string;
        medium: string;
        small: string;
      };
    };

    it("should handle undefined input", () => {
      const result = transformVariantSelection();
      expect(result).toEqual({});
    });

    it("should handle empty array input", () => {
      const result = transformVariantSelection([]);
      expect(result).toEqual({});
    });

    it("should transform array of style variants to object with boolean values", () => {
      const result = transformVariantSelection<ExampleVariant>([
        "disabled",
        "rounded"
      ]);
      expect(result).toEqual({ disabled: true, rounded: true });
    });

    it("should handle mixed array of style variants and objects", () => {
      const result = transformVariantSelection<ExampleVariant>([
        "outlined",
        { disabled: true, rounded: false }
      ]);
      expect(result).toEqual({
        outlined: true,
        disabled: true,
        rounded: false
      });
    });

    it("should pass through object input of style variants", () => {
      const result = transformVariantSelection<ExampleVariant>({
        outlined: true,
        color: "primary",
        size: "medium"
      });
      expect(result).toEqual({
        outlined: true,
        color: "primary",
        size: "medium"
      });
    });

    it("should handle complex style combinations", () => {
      const result = transformVariantSelection<ExampleVariant>([
        "disabled",
        { outlined: true, color: "primary" },
        { size: "medium" },
        "rounded"
      ]);
      expect(result).toEqual({
        disabled: true,
        outlined: true,
        color: "primary",
        size: "medium",
        rounded: true
      });
    });
  });

  describe("transformToggleVariants", () => {
    it("should handle toggle variants", () => {
      const input = {
        disabled: { opacity: 0.5 },
        rounded: { borderRadius: "4px" }
      };
      expect(transformToggleVariants(input)).toEqual({
        disabled: {
          true: { opacity: 0.5 }
        },
        rounded: {
          true: { borderRadius: "4px" }
        }
      });
    });
  });
}
