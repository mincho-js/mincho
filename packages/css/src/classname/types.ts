// == cx() Types ===============================================================
/*
 * Based on the types from clsx
 * https://github.com/lukeed/clsx/blob/master/clsx.d.mts
 */

// -- Primitive Types (single values, evaluated directly) ----------------------
/**
 * Values that convert directly to class names
 * - string: used as-is ("btn" → "btn")
 * - number: converted to string (0 is falsy so excluded, 1 → "1")
 * - bigint: converted to string (1n → "1")
 */
type ClassStringable = string | number;
// | bigint // BigInt not supported in clsx

/**
 * Falsy values that are ignored
 * - Allows false branches in conditional expressions
 * - e.g., clsx(isActive && "active") → false is passed when isActive is false
 */
type ClassFalsy = false | null | undefined | 0 | 0n | "";

/**
 * true has no meaning on its own,
 * but allowed for type compatibility with conditional expressions
 * e.g., clsx(condition && "class") where condition is boolean type
 */
type ClassIgnored = true | bigint;

/**
 * All primitive values
 */
type ClassPrimitive = ClassStringable | ClassFalsy | ClassIgnored;

// -- Composite Types (complex values, processed recursively) ------------------
/**
 * Dictionary Value: evaluated as truthy/falsy to determine inclusion
 * - boolean: explicit include/exclude
 * - null/undefined: excluded (allows optional chaining results)
 * - string/number: included if truthy (empty string, 0 are falsy)
 *
 * Note: nested objects or arrays do not work as intended
 */
type ClassToggle = boolean | string | number | null | undefined;

/**
 * Conditional class specification in object form
 * @example { 'btn-primary': isPrimary, 'disabled': isDisabled }
 */
type ClassDictionary<ClassKey extends ClassStringable = ClassStringable> =
  Partial<Record<ClassKey, ClassToggle>>;

export type ClassValue<
  ClassKey extends ClassStringable | undefined = undefined
> = [ClassKey] extends [undefined]
  ? ClassPrimitive | ClassDictionary<ClassStringable> | ClassValue<undefined>[]
  :
      | ClassKey
      | ClassDictionary<Exclude<ClassKey, undefined>>
      | ClassValue<ClassKey>[];

// == cx().multiple Types ======================================================
/*
 * Input map for cx.multiple()
 */
export type ClassMultipleInput<Input extends ClassValue = ClassValue> = Record<
  string,
  Input
>;

export type ClassMultipleResult<T extends ClassMultipleInput> = {
  [K in keyof T]: string;
};

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, assertType } = import.meta.vitest;

  // == ClassValue Type Tests ==================================================
  describe.concurrent("ClassValue Type Test", () => {
    function assertClassValue<T extends ClassValue>(value: T) {
      assertType<ClassValue>(value);
      return value;
    }

    it("accepts string values", () => {
      assertClassValue("btn");
      assertClassValue("active");
      assertClassValue("my-class-name");
    });

    it("accepts number values", () => {
      assertClassValue(1);
      assertClassValue(42);
      assertClassValue(100);
    });

    it("accepts falsy values for conditional expressions", () => {
      // false - allows `condition && "class"` pattern
      assertClassValue(false);
      // null/undefined - allows optional chaining results
      assertClassValue(null);
      assertClassValue(undefined);
      // 0 and 0n - numeric falsy values
      assertClassValue(0);
      assertClassValue(0n);
      // empty string
      assertClassValue("");
    });

    it("accepts ignored values (true, bigint)", () => {
      // true - for type compatibility with boolean conditions
      assertClassValue(true);
      // bigint - converted to string at runtime
      assertClassValue(1n);
      assertClassValue(100n);
    });

    it("accepts arrays of class values", () => {
      assertClassValue(["btn", "active"]);
      assertClassValue([1, 2, 3]);
      assertClassValue(["btn", null, undefined, false]);
    });

    it("accepts nested arrays", () => {
      assertClassValue([["a", "b"], "c"]);
      assertClassValue([[["deeply"], "nested"], "array"]);
    });

    it("accepts ClassDictionary objects", () => {
      assertClassValue({ btn: true, active: false });
      assertClassValue({ primary: true, disabled: null });
      assertClassValue({ hover: "enabled", count: 5 });
    });

    it("accepts mixed arrays with primitives and objects", () => {
      assertClassValue(["btn", { active: true }, null]);
      assertClassValue([{ primary: true }, "label", false, ["nested"]]);
    });

    it("rejects invalid dictionary value types", () => {
      // @ts-expect-error: Object values are not valid ClassToggle
      assertClassValue({ btn: true, nested: { bad: true } });
      // @ts-expect-error: Array values are not valid ClassToggle
      assertClassValue({ btn: true, arr: ["a", "b"] });
    });
  });

  // == ClassValue with ClassKey Type Tests ====================================
  describe.concurrent("ClassValue with ClassKey Type Test", () => {
    type AllowedKeys = "btn" | "active" | "disabled";

    function assertClassValueWithKey<T extends ClassValue<AllowedKeys>>(
      value: T
    ) {
      assertType<ClassValue<AllowedKeys>>(value);
      return value;
    }

    it("accepts allowed string keys", () => {
      assertClassValueWithKey("btn");
      assertClassValueWithKey("active");
      assertClassValueWithKey("disabled");
    });

    it("rejects disallowed string keys", () => {
      // @ts-expect-error: "unknown" is not in AllowedKeys
      assertClassValueWithKey("unknown");
      // @ts-expect-error: "primary" is not in AllowedKeys
      assertClassValueWithKey("primary");
    });

    it("accepts dictionary with allowed keys", () => {
      assertClassValueWithKey({ btn: true });
      assertClassValueWithKey({ active: false, disabled: true });
      assertClassValueWithKey({ btn: true, active: null, disabled: undefined });
    });

    it("rejects dictionary with only disallowed keys", () => {
      // @ts-expect-error: "unknown" is not in AllowedKeys
      assertClassValueWithKey({ unknown: true });
    });

    it("accepts arrays with allowed keys", () => {
      assertClassValueWithKey(["btn", "active"]);
      assertClassValueWithKey(["btn", { active: true }]);
      assertClassValueWithKey([["btn"], { disabled: false }, "active"]);
    });

    it("rejects arrays with disallowed keys", () => {
      // @ts-expect-error: "unknown" is not in AllowedKeys
      assertClassValueWithKey(["btn", "unknown"]);
      // @ts-expect-error: "primary" is not in AllowedKeys
      assertClassValueWithKey(["btn", { primary: true }]);
    });
  });

  // == ClassDictionary Type Tests =============================================
  describe.concurrent("ClassDictionary Type Test", () => {
    function assertClassDictionary<T extends ClassDictionary>(value: T) {
      assertType<ClassDictionary>(value);
      return value;
    }

    it("accepts boolean toggle values", () => {
      assertClassDictionary({ active: true, disabled: false });
      assertClassDictionary({ "btn-primary": true, "btn-secondary": false });
    });

    it("accepts string values (truthy check at runtime)", () => {
      assertClassDictionary({ btn: "primary" });
      assertClassDictionary({ variant: "outlined", size: "large" });
    });

    it("accepts number values (truthy check at runtime)", () => {
      assertClassDictionary({ count: 5 });
      assertClassDictionary({ level: 0, priority: 1 }); // 0 is falsy
    });

    it("accepts null and undefined values (excluded at runtime)", () => {
      assertClassDictionary({ maybe: null });
      assertClassDictionary({ perhaps: undefined });
      assertClassDictionary({ a: null, b: undefined, c: true });
    });

    it("accepts mixed valid ClassToggle values", () => {
      assertClassDictionary({
        isActive: true,
        isDisabled: false,
        variant: "primary",
        count: 42,
        optional: null,
        missing: undefined
      });
    });

    it("rejects invalid value types", () => {
      assertClassDictionary({
        btn: true,
        // @ts-expect-error: Object is not a valid ClassToggle
        nested: { bad: true }
      });
      assertClassDictionary({
        btn: true,
        // @ts-expect-error: Array is not a valid ClassToggle
        items: ["a", "b"]
      });
      assertClassDictionary({
        btn: true,
        // @ts-expect-error: Symbol is not a valid ClassToggle
        sym: Symbol("test")
      });
    });
  });

  // == ClassDictionary with ClassKey Type Tests ===============================
  describe.concurrent("ClassDictionary with ClassKey Type Test", () => {
    type AllowedKeys = "btn" | "active" | "disabled";

    function assertClassDictionaryWithKey<
      T extends ClassDictionary<AllowedKeys>
    >(value: T) {
      assertType<ClassDictionary<AllowedKeys>>(value);
      return value;
    }

    it("accepts dictionary with allowed keys only", () => {
      assertClassDictionaryWithKey({ btn: true });
      assertClassDictionaryWithKey({ active: false, disabled: true });
      assertClassDictionaryWithKey({
        btn: "primary",
        active: 1,
        disabled: null
      });
    });

    it("rejects dictionary with only disallowed keys", () => {
      // @ts-expect-error: "unknown" is not in AllowedKeys
      assertClassDictionaryWithKey({ unknown: true });
    });
  });

  // == ClassMultipleInput Type Tests ==========================================
  describe.concurrent("ClassMultipleInput Type Test", () => {
    function assertClassMultipleInput<T extends ClassMultipleInput>(value: T) {
      assertType<ClassMultipleInput>(value);
      return value;
    }

    it("accepts record with string ClassValue", () => {
      assertClassMultipleInput({ root: "btn", label: "text" });
      assertClassMultipleInput({ container: "wrapper", item: "element" });
    });

    it("accepts record with array ClassValue", () => {
      assertClassMultipleInput({ root: ["btn", "active"] });
      assertClassMultipleInput({ root: ["a", "b"], label: ["x", "y"] });
    });

    it("accepts record with ClassDictionary values", () => {
      assertClassMultipleInput({ root: { btn: true, active: false } });
      assertClassMultipleInput({
        root: { primary: true },
        label: { bold: true, italic: false }
      });
    });

    it("accepts record with mixed ClassValue types", () => {
      assertClassMultipleInput({
        root: "btn",
        label: ["text", "bold"],
        icon: { visible: true },
        wrapper: ["container", { centered: true }, null]
      });
    });

    it("accepts record with falsy and ignored values", () => {
      assertClassMultipleInput({
        root: false,
        label: null,
        icon: undefined,
        wrapper: 0,
        container: true
      });
    });

    it("accepts complex nested structures", () => {
      assertClassMultipleInput({
        root: [["deeply", "nested"], { active: true }, "simple"],
        label: [[["very"], "deep"], null, { visible: false }]
      });
    });
  });

  // == ClassMultipleResult Type Tests =========================================
  describe.concurrent("ClassMultipleResult Type Test", () => {
    it("returns string values for each input key", () => {
      type Input = { root: ClassValue; label: ClassValue };
      type Result = ClassMultipleResult<Input>;

      // Result should be { root: string; label: string }
      assertType<Result>({ root: "compiled-class", label: "another-class" });

      // @ts-expect-error: number is not assignable to string
      assertType<Result>({ root: 123, label: "class" });

      // @ts-expect-error: missing required key 'label'
      assertType<Result>({ root: "class" });
    });

    it("preserves exact keys from input type", () => {
      type Input = {
        container: ClassValue;
        header: ClassValue;
        footer: ClassValue;
      };
      type Result = ClassMultipleResult<Input>;

      assertType<Result>({
        container: "container-class",
        header: "header-class",
        footer: "footer-class"
      });

      assertType<Result>({
        container: "a",
        header: "b",
        footer: "c",
        // @ts-expect-error: 'extra' does not exist in type Result
        extra: "d"
      });
    });

    it("works with dynamic string keys", () => {
      type Input = Record<string, ClassValue>;
      type Result = ClassMultipleResult<Input>;

      // With Record<string, ClassValue>, result is Record<string, string>
      const result: Result = {
        anyKey: "class",
        anotherKey: "another-class"
      };
      assertType<Result>(result);
    });

    it("maintains type inference from specific input", () => {
      // Simulating the actual usage pattern
      function classMultiple<T extends ClassMultipleInput>(
        _input: T
      ): ClassMultipleResult<T> {
        // Implementation would process input and return compiled classes
        return {} as ClassMultipleResult<T>;
      }

      const result = classMultiple({
        root: "btn",
        label: ["text", { bold: true }]
      });

      // Type should be inferred as { root: string; label: string }
      assertType<{ root: string; label: string }>(result);

      // Accessing valid keys
      const _rootClass: string = result.root;
      const _labelClass: string = result.label;

      // @ts-expect-error: 'unknown' does not exist on result type
      const _invalidKey = result.unknown;

      // Suppress unused variable warnings
      void _rootClass;
      void _labelClass;
      void _invalidKey;
    });
  });
}
