import { describe, expect, it } from "vitest";
import {
  CompilerPayloadCache,
  compilerPayloadContext
} from "./compilerPayload.js";

const source = "x".repeat(40 * 1024);
const scope = {
  environment: "browser",
  generation: 1,
  context: compilerPayloadContext(["compiler", "/entry.ts", { mode: "a" }])
};

describe("compiler source payload cache", () => {
  it("does not alias distinct UTF-16 sources that have the same UTF-8 replacement bytes", () => {
    const cache = new CompilerPayloadCache(400_000);
    const left = source + "\ud800";
    const right = source + "\ufffd";

    expect(Buffer.from(left).equals(Buffer.from(right))).toBe(true);

    const first = cache.prepare(scope, left)!;
    const second = cache.prepare(scope, right)!;

    expect(first.reference.id).not.toBe(second.reference.id);
    expect(second.inline).toBe(true);
    expect(cache.get(first.reference)).toBe(left);
    expect(cache.get(second.reference)).toBe(right);
  });

  it("uses direct seeds after repeated worker misses and probes again within a bound", () => {
    const cache = new CompilerPayloadCache(200_000);
    const payload = cache.prepare(scope, source)!;
    cache.feedback(payload.reference, false);
    cache.feedback(payload.reference, false);

    expect(cache.prepare(scope, source)?.inline).toBe(true);
    expect(cache.prepare(scope, source)?.inline).toBe(true);
    expect(cache.prepare(scope, source)?.inline).toBe(false);

    cache.feedback(payload.reference, true);

    expect(cache.prepare(scope, source)?.inline).toBe(false);

    cache.reset(scope.environment);
    cache.feedback(payload.reference, false);

    expect(cache.count).toBe(0);
  });

  it("keeps first use inline and only references repeated immutable bytes", () => {
    const cache = new CompilerPayloadCache(200_000);
    const first = cache.prepare(scope, source)!;

    expect(first.inline).toBe(true);
    expect(cache.prepare(scope, source)).toEqual({ ...first, inline: false });
    expect(cache.prepare(scope, "short")).toBeUndefined();
    expect(cache.prepare(scope, source.repeat(3))).toBeUndefined();
    expect(cache.bytes).toBeLessThanOrEqual(cache.maxBytes);
  });

  it("isolates environments, generations, compiler/options and module identity", () => {
    const cache = new CompilerPayloadCache(1_000_000);
    const first = cache.prepare(scope, source)!;

    for (const changed of [
      { ...scope, environment: "ssr" },
      { ...scope, generation: 2 },
      {
        ...scope,
        context: compilerPayloadContext([
          "compiler-v2",
          "/entry.ts",
          { mode: "a" }
        ])
      },
      {
        ...scope,
        context: compilerPayloadContext([
          "compiler",
          "/other.ts",
          { mode: "a" }
        ])
      },
      {
        ...scope,
        context: compilerPayloadContext([
          "compiler",
          "/entry.ts",
          { mode: "b" }
        ])
      }
    ]) {
      const next = cache.prepare(changed, source)!;

      expect(next.inline).toBe(true);
      expect(next.reference.id).not.toBe(first.reference.id);
      expect(cache.get({ ...first.reference, ...changed })).toBeUndefined();
    }

    cache.reset(scope.environment, 2);

    expect(cache.get(first.reference)).toBeUndefined();

    cache.reset("ssr");

    expect(cache.count).toBe(1);
  });

  it("bounds both entries and retained UTF-16 bytes and validates fetched content", () => {
    const sender = new CompilerPayloadCache(200_000, 1);
    const first = sender.prepare(scope, source)!;
    sender.prepare(scope, source.replace(/^x/, "y"));

    expect(sender.get(first.reference)).toBeUndefined();
    expect(sender.count).toBe(1);

    const worker = new CompilerPayloadCache(100_000);

    expect(() => worker.accept(first.reference, source + "different")).toThrow(
      "content address"
    );
    expect(worker.count).toBe(0);

    worker.accept(first.reference, source);

    expect(worker.get(first.reference)).toBe(source);

    const unicode = "😀".repeat(20_000);
    const unicodeReference = worker.prepare(scope, unicode)!;

    expect(unicodeReference.reference.bytes).toBe(Buffer.byteLength(unicode));
    expect(worker.bytes).toBeLessThanOrEqual(worker.maxBytes);
  });
});
