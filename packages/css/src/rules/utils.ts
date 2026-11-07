import type {
  VariantGroups,
  VariantSelection,
  VariantObjectSelection
} from "./types.js";

export function mapValues<Input extends Record<string, unknown>, OutputValue>(
  input: Input,
  fn: (value: Input[keyof Input], key: keyof Input) => OutputValue
): Record<keyof Input, OutputValue> {
  const result = {} as Record<keyof Input, OutputValue>;

  for (const key in input) {
    if (
      key === "__proto__" ||
      !Object.prototype.hasOwnProperty.call(input, key)
    )
      continue;
    result[key] = fn(input[key], key);
  }

  return result;
}

export function transformVariantSelection<Variants extends VariantGroups>(
  variants?: VariantSelection<Variants>
): VariantObjectSelection<Variants> {
  if (!Array.isArray(variants)) return variants ?? {};

  const selection = variants.reduce<Record<string, unknown>>((acc, variant) => {
    if (typeof variant === "string") {
      acc[variant] = true;
    } else {
      Object.assign(acc, variant);
    }

    return acc;
  }, Object.create(null));

  // Definitions ignore this key; keep it out of serialized selections too.
  delete selection.__proto__;

  return selection as VariantObjectSelection<Variants>;
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

    it("isolates array selections while preserving own keys and getter reads", () => {
      const selection = JSON.parse(
        '{"__proto__":{"outlined":true},"constructor":"safe","prototype":false,"size":"small"}'
      );
      const extra = Symbol("extra");
      let reads = 0;
      Object.defineProperty(selection, extra, {
        enumerable: true,
        get: () => {
          reads += 1;
          return "preserved";
        }
      });

      const result = transformVariantSelection<ExampleVariant>([
        selection,
        { size: "large" },
        "disabled"
      ]);

      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(result).toEqual({
        constructor: "safe",
        prototype: false,
        size: "large",
        disabled: true,
        [extra]: "preserved"
      });
      expect(reads).toBe(1);
    });
  });
}
