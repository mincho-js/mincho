import { clsx } from "clsx";
import type {
  ClassValue,
  ClassMultipleInput,
  ClassMultipleResult
} from "./types.js";

const cxImpl: (...inputs: ClassValue[]) => string = clsx;
/**
 * Conditionally join class names into a single string
 *
 * @param inputs - Class values to merge (strings, objects, arrays, or falsy values)
 * @returns Merged class name string with duplicates preserved
 *
 * @example
 * // Strings (variadic)
 * cx('foo', true && 'bar', 'baz');
 * // => 'foo bar baz'
 *
 * @example
 * // Objects
 * cx({ foo: true, bar: false, baz: isTrue() });
 * // => 'foo baz'
 *
 * @example
 * // Arrays (with nesting)
 * cx(['foo', 0, false, 'bar']);
 * // => 'foo bar'
 *
 * @example
 * // Kitchen sink
 * cx('foo', [1 && 'bar', { baz: false }], ['hello', ['world']], 'cya');
 * // => 'foo bar hello world cya'
 */
export const cx = Object.assign(cxImpl, {
  multiple: cxMultiple,
  with: cxWith
});

function cxMultiple<T extends ClassMultipleInput>(
  map: T
): ClassMultipleResult<T> {
  const result = {} as ClassMultipleResult<T>;

  for (const key in map) {
    result[key] = cxImpl(map[key]);
  }

  return result;
}

function cxWith<const T extends ClassValue>(
  callback?: (params: T) => ClassValue
) {
  const cxFunction = callback ?? ((className: T) => className);

  function cxWithImpl(...className: T[]) {
    const result = className.map((cn) => cxFunction(cn));
    return cxImpl(...result);
  }

  function cxWithMultiple<ClassNameMap extends ClassMultipleInput<T>>(
    classNameMap: ClassNameMap
  ): ClassMultipleResult<ClassNameMap> {
    type TransformedClassNameMap = Record<keyof ClassNameMap, ClassValue>;
    const transformedClassNameMap: TransformedClassNameMap =
      {} as TransformedClassNameMap;
    for (const key in classNameMap) {
      transformedClassNameMap[key] = cxFunction(classNameMap[key]);
    }
    return cxMultiple(transformedClassNameMap);
  }

  return Object.assign(cxWithImpl, { multiple: cxWithMultiple });
}

// == Tests ====================================================================
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343
  const { describe, it, expect, assertType } = import.meta.vitest;

  describe.concurrent("cx()", () => {
    it("handles string inputs (variadic)", () => {
      expect(cx("foo", "bar", "baz")).toBe("foo bar baz");
      expect(cx("foo")).toBe("foo");
      expect(cx("")).toBe("");
    });

    it("handles conditional string inputs", () => {
      const isActive = true;
      const isHidden = false;
      expect(cx("foo", isActive && "bar", "baz")).toBe("foo bar baz");
      expect(cx("foo", isHidden && "bar", "baz")).toBe("foo baz");
      expect(cx("foo", null, "baz")).toBe("foo baz");
      expect(cx("foo", undefined, "baz")).toBe("foo baz");
    });

    it("handles object inputs", () => {
      expect(cx({ foo: true, bar: false, baz: true })).toBe("foo baz");
      expect(cx({ foo: true })).toBe("foo");
      expect(cx({ foo: false })).toBe("");
      expect(cx({ foo: 1, bar: 0, baz: "truthy" })).toBe("foo baz");
    });

    it("handles object inputs (variadic)", () => {
      expect(cx({ foo: true }, { bar: false }, null, { baz: "hello" })).toBe(
        "foo baz"
      );
    });

    it("handles array inputs", () => {
      expect(cx(["foo", 0, false, "bar"])).toBe("foo bar");
      expect(cx(["foo"])).toBe("foo");
      expect(cx([null, undefined, false])).toBe("");
    });

    it("handles array inputs (variadic)", () => {
      expect(
        cx(["foo"], ["", 0, false, "bar"], [["baz", [["hello"], "there"]]])
      ).toBe("foo bar baz hello there");
    });

    it("handles nested arrays", () => {
      expect(cx([["foo", [["bar"]]]])).toBe("foo bar");
      expect(cx(["foo", ["bar", ["baz"]]])).toBe("foo bar baz");
    });

    it("handles kitchen sink (mixed inputs with nesting)", () => {
      const isVisible = true;
      expect(
        cx(
          "foo",
          [isVisible && "bar", { baz: false, bat: null }, ["hello", ["world"]]],
          "cya"
        )
      ).toBe("foo bar hello world cya");
    });

    it("handles number inputs", () => {
      expect(cx(1, 2, 3)).toBe("1 2 3");
      expect(cx("foo", 42, "bar")).toBe("foo 42 bar");
    });

    it.skip("handles bigint inputs", () => {
      // NOTE: CLSX currently does not support BigInt, so these tests are skipped
      expect(cx(BigInt(123))).toBe("123");
      expect(cx("foo", BigInt(42), "bar")).toBe("foo 42 bar");
    });

    it("filters falsy values correctly", () => {
      expect(cx(null)).toBe("");
      expect(cx(undefined)).toBe("");
      expect(cx(true)).toBe("");
      expect(cx(false)).toBe("");
      expect(cx(0)).toBe("");
      expect(cx("")).toBe("");
      expect(cx(null, undefined, true, false, 0, "")).toBe("");
    });

    it("preserves whitespace in class names", () => {
      expect(cx("foo bar")).toBe("foo bar");
    });

    it("handles empty inputs", () => {
      expect(cx()).toBe("");
      expect(cx([])).toBe("");
      expect(cx({})).toBe("");
    });

    it("accepts valid input types", () => {
      assertType<string>(cx("foo"));
      assertType<string>(cx("foo", "bar"));
      assertType<string>(cx({ foo: true }));
      assertType<string>(cx(["foo", "bar"]));
      assertType<string>(cx("foo", { bar: true }, ["baz"]));
      assertType<string>(cx(null, undefined, false));
      assertType<string>(cx(123));
    });
  });

  describe.concurrent("cx.multiple()", () => {
    it("processes a map of class values", () => {
      const result = cx.multiple({
        primary: ["bg-blue-500", "text-white"],
        secondary: ["bg-gray-500", "text-black"]
      });

      expect(result.primary).toBe("bg-blue-500 text-white");
      expect(result.secondary).toBe("bg-gray-500 text-black");
    });

    it("handles mixed input types in map", () => {
      const isHidden = false;
      const result = cx.multiple({
        strings: "foo bar",
        array: ["baz", "qux"],
        object: { enabled: true, disabled: false },
        conditional: ["base", isHidden && "hidden"]
      });

      expect(result.strings).toBe("foo bar");
      expect(result.array).toBe("baz qux");
      expect(result.object).toBe("enabled");
      expect(result.conditional).toBe("base");
    });

    it("handles empty map", () => {
      const result = cx.multiple({});
      expect(result).toEqual({});
    });

    it("preserves keys with empty values", () => {
      const result = cx.multiple({
        empty: [],
        falsy: null
      });

      expect(result.empty).toBe("");
      expect(result.falsy).toBe("");
    });

    it("cx.multiple returns correct type", () => {
      const result = cx.multiple({
        a: "foo",
        b: ["bar"]
      });

      assertType<{ a: string; b: string }>(result);
    });
  });

  describe.concurrent("cx.with()", () => {
    it("creates a typed constraint without transformer", () => {
      type LayoutDisplay = "flex" | "grid" | "block";
      type LayoutSpacing = `p-${number}` | `m-${number}`;
      const layout = cx.with<LayoutDisplay | LayoutSpacing>();

      expect(layout("flex", "p-4")).toBe("flex p-4");
      expect(layout("grid")).toBe("grid");
    });

    it("creates a typed full constraint without transformer", () => {
      type LayoutDisplay = "flex" | "grid" | "block";
      type LayoutSpacing = `p-${number}` | `m-${number}`;
      const layout = cx.with<ClassValue<LayoutDisplay | LayoutSpacing>>();

      expect(layout("flex", "p-4", { block: true })).toBe("flex p-4 block");
      expect(layout("grid", { block: false, "m-1": true })).toBe("grid m-1");
    });

    it("creates a typed constraint with transformer", () => {
      const responsive = cx.with<{ base: string; md?: string; lg?: string }>(
        ({ base, md, lg }) => [base, md && `md:${md}`, lg && `lg:${lg}`]
      );

      expect(
        responsive({ base: "text-sm", md: "text-base", lg: "text-lg" })
      ).toBe("text-sm md:text-base lg:text-lg");
      expect(responsive({ base: "text-sm" })).toBe("text-sm");
    });

    it("filters out non-string and empty values without transformer", () => {
      const test = cx.with<{
        required: string;
        optional?: string;
        flag?: boolean;
      }>();

      expect(test({ required: "foo", optional: undefined, flag: true })).toBe(
        "required flag"
      );
      expect(test({ required: "foo", optional: "" })).toBe("required");
    });

    it("transformer receives all params", () => {
      const test = cx.with<{ a: string; b: boolean }>(({ a, b }) => [
        a,
        b && "active"
      ]);

      expect(test({ a: "base", b: true })).toBe("base active");
      expect(test({ a: "base", b: false })).toBe("base");
    });

    it("cx.with().multiple() processes a map with typed constraint", () => {
      type LayoutDisplay = "flex" | "grid" | "block";
      type LayoutSpacing = `p-${number}` | `m-${number}`;
      const layout = cx.with<LayoutDisplay | LayoutSpacing>();

      const result = layout.multiple({
        card: "flex",
        container: "grid"
      });

      expect(result.card).toBe("flex");
      expect(result.container).toBe("grid");
    });

    it("cx.with().multiple() with transformer", () => {
      const responsive = cx.with<{ base: string; md?: string; lg?: string }>(
        ({ base, md, lg }) => [base, md && `md:${md}`, lg && `lg:${lg}`]
      );

      const result = responsive.multiple({
        heading: { base: "text-xl", md: "text-2xl", lg: "text-3xl" },
        body: { base: "text-sm", md: "text-base" },
        caption: { base: "text-xs" }
      });

      expect(result.heading).toBe("text-xl md:text-2xl lg:text-3xl");
      expect(result.body).toBe("text-sm md:text-base");
      expect(result.caption).toBe("text-xs");
    });

    it("cx.with().multiple() handles empty map", () => {
      const layout = cx.with<"flex" | "grid">();
      const result = layout.multiple({});
      expect(result).toEqual({});
    });

    it("cx.with().multiple() returns correct type", () => {
      const layout = cx.with<"flex" | "grid">();
      const result = layout.multiple({
        a: "flex",
        b: "grid"
      });

      assertType<{ a: string; b: string }>(result);
    });
  });
}
