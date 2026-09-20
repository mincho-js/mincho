import { describe, expect, it } from "vitest";
import { CxCache } from "./cxCache.js";
import { CxArguments } from "./cxArguments.js";

describe("scoped cx cache retention", () => {
  it("borrows tuple space within the total string budget and returns it for results", () => {
    const cache = new CxCache<string>();
    cache.reserveArguments();

    const tuples = new CxArguments(cache);
    const inputs = Array.from({ length: 32 }, (_, index) => [
      `base-${index}`,
      "x".repeat(1800)
    ]);

    let retained = 0;

    for (const values of inputs) {
      const result = values.join(" ");
      retained += values[0].length + values[1].length + result.length;

      expect(tuples.set(values, result)).toBe(true);
    }

    for (const values of inputs)
      expect(tuples.get(values)).toBe(values.join(" "));

    const remaining = 131_072 - retained;
    cache.set("fit", "v".repeat(remaining - 3), remaining - 3);

    expect(cache.get("fit")).toHaveLength(remaining - 3);

    cache.set("overflow", "v".repeat(remaining), remaining);

    expect(cache.get("overflow")).toBeUndefined();

    tuples.releaseForResult(20_000);
    cache.set("unary", "u".repeat(19_995), 19_995);

    expect(cache.get("unary")).toHaveLength(19_995);
    expect(tuples.get(inputs[0])).toBeUndefined();
  });

  it("gives used entries a second chance when cold entries fill the cache", () => {
    const cache = new CxCache<string>();

    for (let index = 0; index < 1024; index += 1)
      cache.set(`key-${index}`, "value", 5);

    expect(cache.get("key-0")).toBe("value");

    cache.set("new", "value", 5);

    expect(cache.get("key-1")).toBeUndefined();
    expect(cache.get("key-0")).toBe("value");
  });

  it("reserves tuple space before retaining any tuple, and releases it on disable", () => {
    const cache = new CxCache<string>();
    const large = "😀".repeat(60_000);
    cache.set("before", large, large.length);
    cache.reserveArguments();

    expect(cache.get("before")).toBeUndefined();

    cache.set("too-large-for-reservation", large, large.length);

    expect(cache.get("too-large-for-reservation")).toBeUndefined();

    cache.releaseArguments();
    cache.set("after", large, large.length);

    expect(cache.get("after")).toBe(large);
  });

  it("counts both key and result strings in its shared budget", () => {
    const cache = new CxCache<string>();
    const key = "k".repeat(10_000);
    const value = "😀".repeat(27_760);
    cache.set(key + "0", value, value.length);
    cache.set(key + "1", value, value.length);

    expect(cache.get(key + "0")).toBe(value);

    cache.set(key + "2", value, value.length);

    expect(cache.get(key + "1")).toBeUndefined();

    const oversized = "x".repeat(131_072);
    cache.set("oversized", oversized, oversized.length);

    expect(cache.get("oversized")).toBeUndefined();
    expect(cache.get(key + "0")).toBe(value);
  });

  it("warms a 512-tuple working set before judging its reuse", () => {
    const results = new CxCache<string>();
    results.reserveArguments();

    const hot = new CxArguments(results);

    for (let round = 0; round < 8; round += 1) {
      for (let index = 0; index < 512; index += 1) {
        const args = ["base", `variant-${index}`];
        const expected = args.join(" ");
        const cached = hot.get(args);

        if (round > 0) expect(cached).toBe(expected);
        if (cached === undefined) hot.set(args, expected);
      }
    }

    expect(hot.enabled).toBe(true);

    const cold = new CxArguments();

    for (let index = 0; index < 575; index += 1) {
      const args = ["base", `request-${index}`];

      expect(cold.get(args)).toBeUndefined();

      cold.set(args, args.join(" "));
    }

    expect(cold.enabled).toBe(true);
    expect(cold.get(["base", "request-575"])).toBeUndefined();
    expect(cold.enabled).toBe(false);
    expect(cold.set(["base", "request-575"], "unused")).toBe(false);
    expect(cold.get(["base", "request-574"])).toBeUndefined();
  });

  it("shares the entry limit between 512 tuples and 512 results", () => {
    const results = new CxCache<string>();
    results.reserveArguments();

    const tuples = new CxArguments(results);

    for (let index = 0; index < 512; index += 1) {
      results.set(`key-${index}`, "value", 5);

      expect(tuples.set(["base", `v-${index}`], `v-${index}`)).toBe(true);
    }

    for (let index = 0; index < 512; index += 1) {
      expect(tuples.get(["base", `v-${index}`])).toBe(`v-${index}`);
      expect(results.get(`key-${index}`)).toBe("value");
    }

    results.set("overflow", "value", 5);

    expect(results.get("key-0")).toBeUndefined();
    expect(results.get("key-1")).toBe("value");
    expect(tuples.get(["base", "v-0"])).toBe("v-0");
  });

  it.each([15, 16])(
    "retains tuples at the 16/64 hit boundary: %i hits",
    (hits) => {
      const cache = new CxArguments();
      cache.set(["base", "hot"], "cached");

      for (let index = 0; index < 512; index += 1)
        expect(cache.getPredicted("base", "hot", undefined)).toBe("cached");

      for (let index = 0; index < 64 - hits; index += 1)
        expect(cache.get(["base", `miss-${index}`])).toBeUndefined();

      for (let index = 0; index < hits; index += 1)
        expect(cache.getPredicted("base", "hot", undefined)).toBe("cached");

      expect(cache.enabled).toBe(hits === 16);
      expect(cache.get(["base", "hot"])).toBe(
        hits === 16 ? "cached" : undefined
      );
    }
  );

  it.each([15, 16])(
    "judges prediction independently of tuple hits: %i predictions",
    (hits) => {
      const cache = new CxArguments();

      for (let index = 0; index < 64; index += 1)
        cache.set(["base", `v-${index}`], `result-${index}`);

      for (let index = 0; index < 512; index += 1)
        cache.getPredicted("base", "v-63", undefined);

      // Jump past each entry's original sequential successor, with no repeats.
      let last = 63;

      for (let index = 0; index < 64 - hits; index += 1) {
        last = (index * 17) % 64;

        expect(cache.get(["base", `v-${last}`])).toBe(`result-${last}`);
      }

      for (let index = 0; index < hits; index += 1)
        expect(cache.getPredicted("base", `v-${last}`, undefined)).toBe(
          `result-${last}`
        );

      expect(cache.enabled).toBe(true);
      expect(cache.getPredicted("base", `v-${last}`, undefined)).toBe(
        hits === 16 ? `result-${last}` : undefined
      );
      expect(cache.get(["base", `v-${last}`])).toBe(`result-${last}`);
    }
  );

  it("never accepts a hash collision or mutable reference as a tuple hit", () => {
    const cache = new CxArguments();

    // Both strings have identical length, first, middle, and last code units.
    cache.set(["aXbcd", "same"], "first");

    expect(cache.get(["aYbcd", "same"])).toBeUndefined();

    cache.set(["aYbcd", "same"], "second");

    expect(cache.get(["aXbcd", "same"])).toBe("first");
    expect(cache.get([false, "aYbcd", null, "same"])).toBe("second");
    expect(cache.get([["aXbcd"], "same"])).toBeUndefined();
    expect(cache.get([{ aXbcd: true }, "same"])).toBeUndefined();
    expect(cache.get(["aXbcd", 1, "same"])).toBeUndefined();
  });

  it("preserves entries and exact comparisons when first strings become shared", () => {
    const cache = new CxArguments();
    cache.set(["first", "aXbcd", "same"], "original");
    cache.set(["second", "other"], "independent");

    expect(cache.get([false, "first", "aXbcd", "same"])).toBe("original");

    // Sharing the first string changes the index; these sampled hashes also
    // collide, so the resulting bucket must still compare the full strings.
    cache.set(["first", "aYbcd", "same"], "collision");

    expect(cache.get(["first", "aXbcd", "same"])).toBe("original");
    expect(cache.get(["first", "aYbcd", "same"])).toBe("collision");
    expect(cache.get(["second", "other"])).toBe("independent");
    expect(cache.get(["first", "aZbcd", "same"])).toBeUndefined();
    expect(cache.get(["first", ["aXbcd"], "same"])).toBeUndefined();
  });

  it("checks complete scalar tuples in the two/three-argument prediction", () => {
    const cache = new CxArguments();
    cache.set(["a", "b"], "pair");

    for (const falsy of [false, undefined, null, 0, NaN, ""]) {
      expect(cache.getPredicted(falsy, "a", "b")).toBe("pair");
      expect(cache.getPredicted("a", falsy, "b")).toBe("pair");
      expect(cache.getPredicted("a", "b", falsy)).toBe("pair");
    }

    for (const value of [true, 1, ["b"], { b: true }]) {
      expect(cache.getPredicted("a", value, undefined)).toBeUndefined();
    }

    cache.set(["a", "b", "c", "d"], "four");

    expect(cache.getPredicted("a", "b", "c")).toBeUndefined();

    cache.set(["a", "b", "c"], "three");

    expect(cache.getPredicted("a", "b", "c")).toBe("three");
    expect(cache.get(["a", "b", "c", "d"])).toBe("four");
  });

  it("matches short predictions only for the complete ordered truthy strings", () => {
    const values = [
      "a",
      "b",
      "c",
      false,
      null,
      undefined,
      0,
      NaN,
      "",
      true,
      1,
      ["a"],
      { a: true }
    ];

    const tuples = [
      ["a", "b"],
      ["a", "a"],
      ["a", "b", "c"],
      ["a", "b", "c", "d"]
    ];

    for (const tuple of tuples) {
      const cache = new CxArguments();
      cache.set(tuple, "match");

      for (const first of values) {
        for (const second of values) {
          for (const third of values) {
            const normalized = [first, second, third].filter(Boolean);
            const matches =
              normalized.length === tuple.length &&
              normalized.every((value, index) => value === tuple[index]);

            expect(cache.getPredicted(first, second, third)).toBe(
              matches ? "match" : undefined
            );
          }
        }
      }
    }
  });

  it("checks every truthy value when many argument slots use compact tuples", () => {
    const cache = new CxArguments();
    cache.set(["a", "b"], "pair");

    const slots = [false, "a", null, 0, "b", undefined, NaN, ""];

    expect(cache.getPredictedMany(...slots)).toBe("pair");
    expect(cache.getPredictedMany(...slots, "c")).toBeUndefined();
    expect(cache.getPredictedMany("a", ["b"], false, null)).toBeUndefined();

    cache.set(["a", "b", "c", "d"], "four");

    expect(cache.getPredictedMany("a", "b", "c", "d")).toBe("four");
    expect(cache.getPredictedMany("a", "b", "d", "c")).toBeUndefined();
    expect(cache.get(slots)).toBe("pair");
    expect(cache.getPredictedMany(...slots)).toBe("pair");
  });

  it("drops prediction links when tuple retention rotates or exceeds its budget", () => {
    const cache = new CxArguments();

    for (let index = 0; index < 513; index += 1)
      cache.set(["base", `class-${index}`], `result-${index}`);

    expect(cache.get(["base", "class-0"])).toBeUndefined();
    expect(cache.get(["base", "class-512"])).toBe("result-512");

    const input = "😀".repeat(1500);
    cache.set([input, "last"], "x".repeat(20_000));

    expect(cache.get([input, "last"])).toBeUndefined();

    cache.set(["x".repeat(4097), "last"], "small");

    expect(cache.get(["x".repeat(4097), "last"])).toBeUndefined();
    expect(cache.get(["base", "class-512"])).toBe("result-512");
  });
});
