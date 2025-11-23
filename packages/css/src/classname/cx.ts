import { clsx } from "clsx";
import type { ClassMultipleInput, ClassMultipleResult } from "./types.js";

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
export const cx = Object.assign(clsx, {
  multiple: cxMultiple
});

function cxMultiple<T extends ClassMultipleInput>(
  map: T
): ClassMultipleResult<T> {
  const result = {} as ClassMultipleResult<T>;

  for (const key in map) {
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      result[key] = clsx(map[key]);
    }
  }

  return result;
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
      expect(cx(false)).toBe("");
      expect(cx(0)).toBe("");
      expect(cx("")).toBe("");
      expect(cx(null, undefined, false, 0, "")).toBe("");
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
}
