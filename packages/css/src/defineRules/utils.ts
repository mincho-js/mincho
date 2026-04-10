import type { CSSRule } from "@mincho-js/transform-to-vanilla";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import { css } from "../css/index.js";
import { identifierName } from "../utils.js";

type CanonicalNode =
  | ["null"]
  | ["undefined"]
  | ["boolean", boolean]
  | ["number", string]
  | ["string", string]
  | ["bigint", string]
  | ["date", string]
  | ["array", CanonicalNode[]]
  | ["set", CanonicalNode[]]
  | ["map", Array<[CanonicalNode, CanonicalNode]>]
  | ["object", Array<[string, CanonicalNode]>];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sortByStableString<T>(items: readonly T[]): T[] {
  return [...items]
    .map((item) => ({ item, key: JSON.stringify(item) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ item }) => item);
}

function canonicalize(
  value: unknown,
  stack: WeakSet<object> = new WeakSet()
): CanonicalNode {
  if (value === null) {
    return ["null"];
  }

  switch (typeof value) {
    case "string":
      return ["string", value];

    case "boolean":
      return ["boolean", value];

    case "number":
      if (Number.isNaN(value)) {
        return ["number", "NaN"];
      }
      if (Object.is(value, -0)) {
        return ["number", "-0"];
      }
      return ["number", String(value)];

    case "bigint":
      return ["bigint", value.toString()];

    case "undefined":
      return ["undefined"];

    case "object":
      break;

    default:
      throw new TypeError(`Not supported type: ${typeof value}`);
  }

  if (value instanceof Date) {
    return ["date", value.toISOString()];
  }

  if (stack.has(value)) {
    throw new TypeError("Circular reference is not supported.");
  }

  stack.add(value);

  try {
    if (Array.isArray(value)) {
      // Arrays maintain order.
      return ["array", value.map((item) => canonicalize(item, stack))];
    }

    if (value instanceof Set) {
      const items = [...value].map((item) => canonicalize(item, stack));
      return ["set", sortByStableString(items)];
    }

    if (value instanceof Map) {
      const entries = [...value.entries()].map(
        ([k, v]) =>
          [canonicalize(k, stack), canonicalize(v, stack)] as [
            CanonicalNode,
            CanonicalNode
          ]
      );

      return ["map", sortByStableString(entries)];
    }

    if (isPlainObject(value)) {
      const entries = Object.keys(value)
        .sort()
        .map(
          (key) =>
            [key, canonicalize(value[key], stack)] as [string, CanonicalNode]
        );

      return ["object", entries];
    }

    throw new TypeError("Only plain objects, Arrays, Sets, Maps, and Dates are supported.");
  } finally {
    stack.delete(value);
  }
}

function pairCacheKey(key: unknown, value: unknown): string {
  return JSON.stringify(["pair", canonicalize(key), canonicalize(value)]);
}

function fragmentCacheKey(
  key: unknown,
  value: unknown,
  fragment: unknown
): string {
  return JSON.stringify([
    "fragment",
    canonicalize(key),
    canonicalize(value),
    canonicalize(fragment)
  ]);
}

export function createCanonicalStyleCache(debugId?: string) {
  let classNameCache: Record<string, string> = {};

  function hasCacheKey(cacheKey: string): boolean {
    return cacheKey in classNameCache;
  }

  function getCachedClassName(cacheKey: string): string | undefined {
    return classNameCache[cacheKey];
  }

  function cacheClassName(cacheKey: string, style: CSSRule): string {
    const classNameOrUndefined = classNameCache[cacheKey];
    if (classNameOrUndefined != null) {
      return classNameOrUndefined;
    }

    const className = css(style, debugId);
    classNameCache[cacheKey] = className;
    return className;
  }

  function has(key: unknown, value: unknown): boolean {
    return hasCacheKey(pairCacheKey(key, value));
  }

  function get(key: unknown, value: unknown): string | undefined {
    return getCachedClassName(pairCacheKey(key, value));
  }

  function add(key: unknown, value: unknown): string {
    return cacheClassName(pairCacheKey(key, value), {
      [key as string]: value
    } as CSSRule);
  }

  function hasFragment(
    key: unknown,
    value: unknown,
    fragment: CSSRule
  ): boolean {
    return hasCacheKey(fragmentCacheKey(key, value, fragment));
  }

  function getFragment(
    key: unknown,
    value: unknown,
    fragment: CSSRule
  ): string | undefined {
    return getCachedClassName(fragmentCacheKey(key, value, fragment));
  }

  function addFragment(
    key: unknown,
    value: unknown,
    fragment: CSSRule
  ): string {
    return cacheClassName(fragmentCacheKey(key, value, fragment), fragment);
  }

  function clear(): void {
    classNameCache = {};
  }

  return {
    has,
    get,
    add,
    hasFragment,
    getFragment,
    addFragment,
    clear,
    get size() {
      return Object.keys(classNameCache).length;
    }
  };
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;
  const debugId = "createCanonicalStyleCache";
  setFileScope("test");

  function expectClassName(value: string) {
    expect(value).toMatch(identifierName(debugId));
  }

  describe("createCanonicalStyleCache", () => {
    it("should ignore plain object key order in values", () => {
      const cache = createCanonicalStyleCache(debugId);

      expect(cache.has("user", { b: 2, a: 1 })).toBe(false);
      expectClassName(cache.add("user", { b: 2, a: 1 }));
      expect(cache.has("user", { a: 1, b: 2 })).toBe(true);
      expectClassName(cache.add("user", { a: 1, b: 2 }));
      expect(cache.size).toBe(1);
    });

    it("should compare keys using the same canonicalization rules", () => {
      const cache = createCanonicalStyleCache(debugId);

      expect(cache.has({ b: 2, a: 1 }, "value")).toBe(false);
      expectClassName(cache.add({ b: 2, a: 1 }, "value"));
      expect(cache.has({ a: 1, b: 2 }, "value")).toBe(true);
      expect(cache.size).toBe(1);
    });

    it("should treat arrays with different order as different values", () => {
      const cache = createCanonicalStyleCache(debugId);

      expect(cache.has("list", ["a", "b"])).toBe(false);
      expectClassName(cache.add("list", ["a", "b"]));
      expect(cache.has("list", ["b", "a"])).toBe(false);
      expectClassName(cache.add("list", ["a", "b"]));
      expect(cache.size).toBe(1);
    });

    it("should ignore plain object key order inside arrays", () => {
      const cache = createCanonicalStyleCache(debugId);

      expect(cache.has("list", ["x", { b: 2, a: 1 }])).toBe(false);
      expectClassName(cache.add("list", ["x", { b: 2, a: 1 }]));
      expect(cache.has("list", ["x", { a: 1, b: 2 }])).toBe(true);
      expect(cache.has("list", [{ a: 1, b: 2 }, "x"])).toBe(false);
    });

    it("should treat array keys with different order as different keys", () => {
      const cache = createCanonicalStyleCache(debugId);

      expect(cache.has(["a", "b"], "value")).toBe(false);
      expectClassName(cache.add(["a", "b"], "value"));
      expect(cache.has(["b", "a"], "value")).toBe(false);
      expectClassName(cache.add(["a", "b"], "value"));
      expect(cache.size).toBe(1);
    });

    it("should treat different keys with the same value as different pairs", () => {
      const cache = createCanonicalStyleCache(debugId);

      expectClassName(cache.add("user", { a: 1 }));
      expectClassName(cache.add("admin", { a: 1 }));
      expect(cache.size).toBe(2);
    });

    it("should treat different values with the same key as different pairs", () => {
      const cache = createCanonicalStyleCache(debugId);

      expectClassName(cache.add("user", { a: 1 }));
      expectClassName(cache.add("user", { a: 2 }));
      expect(cache.size).toBe(2);
    });

    it("should ignore set element order", () => {
      const cache = createCanonicalStyleCache(debugId);

      const s1 = new Set<unknown>([{ b: 2, a: 1 }, ["x", "y"]]);
      const s2 = new Set<unknown>([["x", "y"], { a: 1, b: 2 }]);

      expectClassName(cache.add("tags", s1));
      expectClassName(cache.add("tags", s2));
      expect(cache.size).toBe(1);
    });

    it("should ignore map entry order", () => {
      const cache = createCanonicalStyleCache(debugId);

      const m1 = new Map<unknown, unknown>([
        ["k1", 1],
        [
          { b: 2, a: 1 },
          { y: 2, x: 1 }
        ]
      ]);

      const m2 = new Map<unknown, unknown>([
        [
          { a: 1, b: 2 },
          { x: 1, y: 2 }
        ],
        ["k1", 1]
      ]);

      expectClassName(cache.add("map", m1));
      expectClassName(cache.add("map", m2));
      expect(cache.size).toBe(1);
    });

    it("should treat dates with the same timestamp as equal values", () => {
      const cache = createCanonicalStyleCache(debugId);

      expectClassName(
        cache.add("createdAt", new Date("2024-01-01T00:00:00.000Z"))
      );
      expect(cache.has("createdAt", new Date("2024-01-01T00:00:00.000Z"))).toBe(
        true
      );
      expectClassName(
        cache.add("createdAt", new Date("2024-01-01T00:00:00.000Z"))
      );
      expect(cache.size).toBe(1);
    });

    it("should treat NaN as equal and distinguish -0 from 0", () => {
      const cache = createCanonicalStyleCache(debugId);

      expectClassName(cache.add("n", NaN));
      expectClassName(cache.add("n", NaN));

      expectClassName(cache.add("zero", -0));
      expect(cache.has("zero", 0)).toBe(false);
      expectClassName(cache.add("zero", 0));

      expect(cache.size).toBe(3);
    });

    it("should support add, get, has, clear, and size", () => {
      const cache = createCanonicalStyleCache(debugId);

      expect(cache.size).toBe(0);
      expect(cache.has("x", { a: 1 })).toBe(false);
      expect(cache.get("x", { a: 1 })).toBe(undefined);
      expect(cache.size).toBe(0);

      const className = cache.add("x", { a: 1 });
      expectClassName(className);
      expect(cache.has("x", { a: 1 })).toBe(true);
      expect(cache.get("x", { a: 1 })).toBe(className);
      cache.add("x", { a: 1 });
      expect(cache.size).toBe(1);

      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.has("x", { a: 1 })).toBe(false);
    });

    it("should ignore plain object key order in whole fragment cache keys and fragments", () => {
      const cache = createCanonicalStyleCache(debugId);

      const className = cache.addFragment(
        "background",
        { b: 2, a: 1 },
        {
          vars: { "--b": "2", "--a": "1" },
          background: "rgb(0, 0, 255)"
        }
      );

      expectClassName(className);
      expect(
        cache.hasFragment(
          "background",
          { a: 1, b: 2 },
          {
            background: "rgb(0, 0, 255)",
            vars: { "--a": "1", "--b": "2" }
          }
        )
      ).toBe(true);
      expect(
        cache.getFragment(
          "background",
          { a: 1, b: 2 },
          {
            background: "rgb(0, 0, 255)",
            vars: { "--a": "1", "--b": "2" }
          }
        )
      ).toBe(className);
      expect(
        cache.addFragment(
          "background",
          { a: 1, b: 2 },
          {
            background: "rgb(0, 0, 255)",
            vars: { "--a": "1", "--b": "2" }
          }
        )
      ).toBe(className);
      expect(cache.size).toBe(1);
    });

    it("should distinguish full and pruned fragments for the same property/value pair in the whole fragment cache", () => {
      const cache = createCanonicalStyleCache(debugId);

      const full = cache.addFragment("background", "red", {
        vars: { "--alpha": "1" },
        background: "rgba(255, 0, 0, var(--alpha))"
      });
      const pruned = cache.addFragment("background", "red", {
        vars: { "--alpha": "1" }
      });

      expectClassName(full);
      expectClassName(pruned);
      expect(pruned).not.toBe(full);
      expect(
        cache.getFragment("background", "red", {
          vars: { "--alpha": "1" }
        })
      ).toBe(pruned);
      expect(cache.size).toBe(2);
    });

    it("should support get, clear, and stable cache identity in the whole fragment cache", () => {
      const cache = createCanonicalStyleCache(debugId);

      const firstFragment = {
        vars: { "--alpha": "1" },
        background: "rgba(255, 0, 0, var(--alpha))"
      } as const;
      const secondFragment = {
        background: "rgba(255, 0, 0, var(--alpha))",
        vars: { "--alpha": "1" }
      } as const;

      expect(cache.getFragment("background", "red", firstFragment)).toBe(
        undefined
      );

      const className = cache.addFragment("background", "red", firstFragment);
      expectClassName(className);
      expect(cache.getFragment("background", "red", secondFragment)).toBe(
        className
      );
      expect(cache.addFragment("background", "red", secondFragment)).toBe(
        className
      );
      expect(cache.size).toBe(1);

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.hasFragment("background", "red", firstFragment)).toBe(false);
      expect(cache.getFragment("background", "red", secondFragment)).toBe(
        undefined
      );
    });

    it("should treat null prototype objects as plain objects", () => {
      const cache = createCanonicalStyleCache(debugId);

      const a = Object.create(null) as Record<string, unknown>;
      a.b = 2;
      a.a = 1;

      const b = Object.create(null) as Record<string, unknown>;
      b.a = 1;
      b.b = 2;

      expectClassName(cache.add("obj", a));
      expectClassName(cache.add("obj", b));
      expect(cache.size).toBe(1);
    });

    it("should reject functions and symbols", () => {
      const cache = createCanonicalStyleCache(debugId);

      expect(() => cache.has("fn", () => undefined)).toThrow(
        /Not supported type/
      );
      expect(() => cache.has("sym", Symbol("x"))).toThrow(/Not supported type/);
    });

    it("should reject class instances", () => {
      const cache = createCanonicalStyleCache(debugId);

      class User {
        constructor(public readonly name: string) {}
      }

      expect(() => cache.has("user", new User("alice"))).toThrow(
        /Only plain objects, Arrays, Sets, Maps, and Dates are supported/
      );
    });

    it("should reject circular references", () => {
      const cache = createCanonicalStyleCache(debugId);

      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(() => cache.has("circular", circular)).toThrow(/Circular reference is not supported/);
    });
  });
}
