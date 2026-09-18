import { describe, expect, it, vi } from "vitest";
import { CompilationCache, type CacheEntry } from "./compilationCache.js";

const entry = (value: number, bytes = 1): CacheEntry<number> => ({
  value,
  bytes,
  dependencies: ["/dep.ts"],

  valid: async () => true
});

describe("compilation cache", () => {
  it("deduplicates pending work, isolates generations and does not retain failures", async () => {
    const cache = new CompilationCache();
    let finish!: (value: CacheEntry<number>) => void;
    const create = vi.fn(
      () =>
        new Promise<CacheEntry<number>>((resolve) => {
          finish = resolve;
        })
    );

    const a = cache.run("a", create);
    const b = cache.run("a", create);

    expect(create).toHaveBeenCalledTimes(1);

    cache.begin();

    expect(await cache.run("a", async () => entry(2))).toBe(2);

    finish(entry(1));

    expect(await Promise.all([a, b])).toEqual([1, 1]);
    expect(await cache.run("a", create)).toBe(2);
    await expect(
      cache.run("failure", async () => {
        throw new Error("failed");
      })
    ).rejects.toThrow("failed");
    expect(await cache.run("failure", async () => entry(3))).toBe(3);
  });

  it("validates dependencies, evicts least recently used entries and respects byte limits", async () => {
    const cache = new CompilationCache(2, 3);
    const create = vi.fn(async () => entry(create.mock.calls.length));
    await cache.run("a", create);
    await cache.run("b", create);
    await cache.run("a", create);
    await cache.run("c", create);

    expect(create).toHaveBeenCalledTimes(3);

    await cache.run("b", create);

    expect(create).toHaveBeenCalledTimes(4);

    await cache.run("b", create, async () => false);

    expect(create).toHaveBeenCalledTimes(5);

    cache.invalidate("/dep.ts");
    await cache.run("b", create);

    expect(create).toHaveBeenCalledTimes(6);

    const large = vi.fn(async () => entry(100, 4));
    await cache.run("large", large);
    await cache.run("large", large);

    expect(large).toHaveBeenCalledTimes(2);
  });
});
