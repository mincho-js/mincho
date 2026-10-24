import { brotliCompressSync, gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveFromModule } from "./moduleResolution.js";
import {
  measureBundleBytes,
  measureBundleMetric,
  runtimeHelperOverhead
} from "./bundleSize.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
vi.mock("./moduleResolution.js", () => ({ resolveFromModule: vi.fn() }));

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();

  return {
    ...actual,
    gzipSync: vi.fn(actual.gzipSync),
    brotliCompressSync: vi.fn(actual.brotliCompressSync)
  };
});

describe("single-metric bundle measurement", () => {
  it.each(["raw", "gzip", "brotli"] as const)(
    "charges only new helper files using %s without other compression work",
    (metric) => {
      const files: Record<string, string> = {
        "/runtime/before.js": 'import "./shared.js"; export const before = 1;',
        "/runtime/after.js": 'import "./shared.js"; import "./extra.js";',
        "/runtime/shared.js": "export const shared = 1;",
        "/runtime/extra.js": "export const extra = 2;"
      };
      vi.mocked(resolveFromModule).mockImplementation(
        (_module, specifier) => `/runtime/${specifier}.js`
      );
      vi.mocked(readFileSync).mockImplementation((file) => {
        const source = files[String(file)];
        if (source === undefined) throw new Error(`Missing fixture: ${file}`);
        return source;
      });
      const expected = measureBundleBytes(
        `${files["/runtime/after.js"]}\n${files["/runtime/extra.js"]}`
      )[metric];
      vi.clearAllMocks();

      expect(runtimeHelperOverhead("before", "after", metric)).toBe(expected);
      expect(gzipSync).toHaveBeenCalledTimes(metric === "gzip" ? 1 : 0);
      expect(brotliCompressSync).toHaveBeenCalledTimes(
        metric === "brotli" ? 1 : 0
      );

      expect(runtimeHelperOverhead("before", "before", "raw")).toBe(0);
      expect(
        runtimeHelperOverhead("before", "missing", metric)
      ).toBeUndefined();
    }
  );

  it.each(["raw", "gzip", "brotli"] as const)(
    "matches the full report while computing only %s",
    (metric) => {
      for (const source of [
        "색상: red;".repeat(20),
        new Uint8Array([0, 255, 1, 128, 42])
      ]) {
        const expected = measureBundleBytes(source)[metric];
        vi.clearAllMocks();

        expect(measureBundleMetric(source, metric)).toBe(expected);
        expect(gzipSync).toHaveBeenCalledTimes(metric === "gzip" ? 1 : 0);
        expect(brotliCompressSync).toHaveBeenCalledTimes(
          metric === "brotli" ? 1 : 0
        );
      }
    }
  );
});
