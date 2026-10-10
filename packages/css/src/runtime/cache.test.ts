import { describe, expect, it } from "vitest";
import { RuntimeCache } from "./cache.js";

describe("runtime cache budget", () => {
  it("evicts least recently used entries at the shared entry limit", () => {
    const cache = new RuntimeCache<string>();

    for (let index = 0; index < 256; index += 1) {
      cache.set(String(index), "value", 5);
    }

    expect(cache.get("0")).toBe("value");

    cache.set("new", "value", 5);

    expect(cache.get("1")).toBeUndefined();
    expect(cache.get("0")).toBe("value");
    expect(cache.get("255")).toBe("value");
  });

  it("accounts for UTF-16 key and value lengths, including replacements", () => {
    const cache = new RuntimeCache<string>();
    const large = "😀".repeat(16_383);
    cache.set("a", large, large.length);
    cache.set("b", large, large.length);
    cache.set("a", "small", 5);
    cache.set("c", large, large.length);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("small");
    expect(cache.get("c")).toBe(large);
  });

  it("does not retain oversized entries or evict useful entries for them", () => {
    const cache = new RuntimeCache<string>();
    cache.set("saved", "result", 6);
    cache.set("oversized", "x".repeat(65_536), 65_536);

    expect(cache.get("oversized")).toBeUndefined();
    expect(cache.get("saved")).toBe("result");
  });

  it("releases entries and their accounted size when cleared", () => {
    const cache = new RuntimeCache<string>();
    const large = "x".repeat(60_000);
    cache.set("old", large, large.length);
    cache.clear();

    expect(cache.get("old")).toBeUndefined();

    cache.set("new", large, large.length);
    cache.set("small", "value", 5);

    expect(cache.get("new")).toBe(large);
    expect(cache.get("small")).toBe("value");
  });
});
