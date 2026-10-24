import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveFromModule } from "./moduleResolution.js";

export interface BundleSizeOptions {
  metric?: "raw" | "gzip" | "brotli";
}

export interface BundleBytes {
  raw: number;
  gzip: number;
  brotli: number;
}

/** Charge all newly referenced runtime files, including unshaken exports. */
export function runtimeHelperOverhead(
  before: string,
  after: string,
  metric: keyof BundleBytes
): number | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: the CJS declaration build checks import.meta as well.
    const moduleUrl = import.meta.url;
    const graph = (specifier: string) => {
      const files = new Map<string, string>();
      const visit = (file: string) => {
        if (files.has(file)) return;
        const source = readFileSync(file, "utf8").replace(
          /\/\/# sourceMappingURL=.*$/gm,
          ""
        );
        files.set(file, source);
        for (const match of source.matchAll(
          /(?:from\s*|import\s*|require\(\s*)["'](\.[^"']+)["']/g
        ))
          visit(resolve(dirname(file), match[1]!));
      };
      visit(resolveFromModule(moduleUrl, specifier));
      return files;
    };
    const original = graph(before),
      candidate = graph(after);
    return measureBundleMetric(
      [...candidate]
        .filter(([file]) => !original.has(file))
        .map(([, source]) => source)
        .join("\n"),
      metric
    );
  } catch {
    return undefined;
  }
}

/** Build-only, asset-local measurements. Never concatenate separately fetched assets. */
export function measureBundleBytes(source: string | Uint8Array): BundleBytes {
  const bytes = typeof source === "string" ? Buffer.from(source) : source;
  return {
    raw: bytes.byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
    }).byteLength
  };
}

/** Compute only the selected asset-local metric when comparing candidates. */
export function measureBundleMetric(
  source: string | Uint8Array,
  metric: keyof BundleBytes
): number {
  const bytes = typeof source === "string" ? Buffer.from(source) : source;

  if (metric === "raw") return bytes.byteLength;
  if (metric === "gzip") return gzipSync(bytes, { level: 9 }).byteLength;

  return brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
  }).byteLength;
}

export function bundleSizeMetric(
  options?: BundleSizeOptions
): keyof BundleBytes {
  const metric = options?.metric ?? "brotli";
  if (!["raw", "gzip", "brotli"].includes(metric))
    throw new TypeError("bundleSize.metric must be raw, gzip, or brotli.");
  return metric;
}
