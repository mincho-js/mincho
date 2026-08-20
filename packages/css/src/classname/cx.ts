import { clsx } from "clsx";
import type {
  ClassValue,
  ClassMultipleInput,
  ClassMultipleResult,
  Cx,
  CxWith,
  CxWithCallback,
  CxWithCallbackArgs,
  CxWithMixin,
  CxWithTupleValue
} from "./types.js";

const cxImpl: (...inputs: ClassValue[]) => string = clsx;

function cxMultipleResult<T extends ClassMultipleInput>(
  mapper: (...inputs: ClassValue[]) => string,
  map: T
): ClassMultipleResult<T> {
  const result = Object.create(null) as ClassMultipleResult<T>;

  for (const key in map) {
    result[key] = mapper(map[key]);
  }

  return result;
}

function createCx(cxImpl: (...inputs: ClassValue[]) => string): Cx {
  function cxMultiple<T extends ClassMultipleInput>(
    map: T
  ): ClassMultipleResult<T> {
    return cxMultipleResult(cxImpl, map);
  }

  function cxWith<const T extends ClassValue>(): CxWith<T>;
  function cxWith<const F extends CxWithCallback>(
    callback: F
  ): CxWithMixin<CxWithCallbackArgs<F>>;
  function cxWith<const Input>(
    callback: (params: Input) => ClassValue
  ): CxWithMixin<[params: Input]>;
  function cxWith<const T extends ClassValue, const F extends CxWithCallback>(
    callback?: ((params: T) => ClassValue) | F
  ): CxWith<T> & CxWithMixin<CxWithCallbackArgs<F>> {
    type CxWithRuntimeCallback = (...className: unknown[]) => ClassValue;
    const cxFunction = (callback ??
      ((...className: ClassValue[]) => className)) as CxWithRuntimeCallback;

    function cxWithImpl(...className: unknown[]) {
      return cxImpl(cxFunction(...className));
    }

    function cxWithMultiple<
      ClassNameMap extends Record<
        string,
        T | CxWithTupleValue<CxWithCallbackArgs<F>>
      >
    >(classNameMap: ClassNameMap): ClassMultipleResult<ClassNameMap> {
      const transformedClassNameMap: Record<keyof ClassNameMap, ClassValue> =
        Object.create(null) as Record<keyof ClassNameMap, ClassValue>;
      for (const key in classNameMap) {
        const value = classNameMap[key];
        transformedClassNameMap[key] = Array.isArray(value)
          ? cxFunction(...value)
          : cxFunction(value);
      }

      return cxMultipleResult(cxImpl, transformedClassNameMap);
    }

    return Object.assign(cxWithImpl, {
      multiple: cxWithMultiple
    }) as CxWith<T> & CxWithMixin<CxWithCallbackArgs<F>>;
  }

  return Object.assign((...inputs: ClassValue[]) => cxImpl(...inputs), {
    multiple: cxMultiple,
    with: cxWith
  });
}

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
export const cx = createCx(cxImpl);
export { createCx };

// == Tests ====================================================================
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343
  const { describe, it, expect, assertType, vi } = import.meta.vitest;

  describe.concurrent("cx()", () => {
    it("keeps caller implementations and independently created helpers isolated", () => {
      const implementation = Object.freeze(
        vi.fn((...inputs: ClassValue[]) => clsx(...inputs))
      );
      const first = createCx(implementation);
      const firstMultiple = first.multiple;
      const firstWith = first.with;
      const second = createCx(implementation);

      expect(first).not.toBe(second);
      expect(first.multiple).toBe(firstMultiple);
      expect(first.with).toBe(firstWith);
      expect(second.multiple).not.toBe(firstMultiple);
      expect(second.with).not.toBe(firstWith);
      expect(implementation).not.toHaveProperty("multiple");
      expect(implementation).not.toHaveProperty("with");
      expect(first("base", false, ["active"])).toBe("base active");
      expect(implementation).toHaveBeenLastCalledWith("base", false, [
        "active"
      ]);
      expect(second.multiple({ item: "second" })).toEqual({ item: "second" });
      expect(first.with((value: string) => value)("first")).toBe("first");
    });

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

    it("handles direct runtime fallback expressions", () => {
      const providedClass = "";
      const maybeClass = null;

      expect(cx("base", providedClass || "fallback")).toBe("base fallback");
      expect(cx("base", maybeClass ?? "fallback")).toBe("base fallback");
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
    it("preserves an own enumerable __proto__ key", () => {
      const result = cx.multiple({
        ["__proto__"]: ["first", false, "second"],
        ordinary: "third"
      });

      expect(Object.entries(result)).toEqual([
        ["__proto__", "first second"],
        ["ordinary", "third"]
      ]);
      expect(Object.getPrototypeOf(result)).toBeNull();
    });

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
    it("preserves an own enumerable __proto__ key through the mapper", () => {
      const mapper = cx.with((name: string) => [name, "active"]);
      const result = mapper.multiple({
        ["__proto__"]: ["base"],
        ordinary: ["next"]
      });

      expect(Object.entries(result)).toEqual([
        ["__proto__", "base active"],
        ["ordinary", "next active"]
      ]);
      expect(Object.getPrototypeOf(result)).toBeNull();
    });

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

    it("creates a typed positional mixin with transformer", () => {
      const responsive = cx.with((base: string, md?: string, lg?: string) => [
        base,
        md && `md:${md}`,
        lg && `lg:${lg}`
      ]);

      assertType<(base: string, md?: string, lg?: string) => string>(
        responsive
      );
      expect(responsive("text-sm", "text-base", "text-lg")).toBe(
        "text-sm md:text-base lg:text-lg"
      );
      expect(responsive("text-sm")).toBe("text-sm");
    });

    it("supports one-argument object mixins with direct multiple values", () => {
      const responsive = cx.with<{ base: string; md?: string }>(
        ({ base, md }) => [base, md && `md:${md}`]
      );

      expect(responsive({ base: "text-sm", md: "text-base" })).toBe(
        "text-sm md:text-base"
      );
      expect(
        responsive.multiple({
          body: { base: "text-sm", md: "text-base" },
          caption: { base: "text-xs" }
        } as const)
      ).toEqual({ body: "text-sm md:text-base", caption: "text-xs" });
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

    it("mixin transformer receives all direct call args at once", () => {
      const callback = vi.fn((base: string, active: boolean) => [
        base,
        active && "active"
      ]);
      const test = cx.with(callback);

      expect(test("base", true)).toBe("base active");
      expect(test("base", false)).toBe("base");
      expect(callback).toHaveBeenNthCalledWith(1, "base", true);
      expect(callback).toHaveBeenNthCalledWith(2, "base", false);
    });

    it("expresses mapper behavior as a rest-args mixin", () => {
      const prefixed = cx.with((...classNames: string[]) =>
        classNames.map((className) => `ui-${className}`)
      );

      expect(prefixed("button", "active")).toBe("ui-button ui-active");
      expect(
        prefixed.multiple({
          button: ["button", "active"],
          icon: ["icon"]
        })
      ).toEqual({ button: "ui-button ui-active", icon: "ui-icon" });
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

    it("cx.with().multiple() with positional mixin transformer", () => {
      const responsive = cx.with((base: string, md?: string, lg?: string) => [
        base,
        md && `md:${md}`,
        lg && `lg:${lg}`
      ]);

      const result = responsive.multiple({
        heading: ["text-xl", "text-2xl", "text-3xl"],
        body: ["text-sm", "text-base"],
        caption: ["text-xs"]
      } as const);

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
