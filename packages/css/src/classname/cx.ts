import { clsx } from "clsx";

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
export const cx = clsx;

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
}
