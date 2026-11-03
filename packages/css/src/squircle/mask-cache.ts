import {
  pathFromGeometry,
  resolveGeometry,
  type Geometry,
  type SquircleOptions
} from "./geometry.js";

export interface MaskAsset {
  readonly image: string;
  readonly path: string;
  readonly geometry: Geometry;
}

const MAX_ENTRIES = 128;
// This limits estimated UTF-16 string storage, not total JS-engine heap usage.
const MAX_STRING_BYTES = 512 * 1024;
const cache = new Map<string, { asset: MaskAsset; bytes: number }>();
let stringBytes = 0;
let hits = 0;
let misses = 0;

function createAsset(g: Geometry, key?: string): MaskAsset {
  const path = pathFromGeometry(g);
  let image: string | undefined;
  const asset: MaskAsset = Object.freeze({
    // Live SVG masks only consume geometry/path. Encode an image only for a
    // stylesheet or server-rendered fallback, and retain it on first access.
    get image() {
      if (image === undefined) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g.width} ${g.height}" preserveAspectRatio="none"><path fill="white" d="${path}"/></svg>`;
        image = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
        if (key !== undefined) trackImage(key, asset, image);
      }
      return image;
    },
    path,
    geometry: Object.freeze(g)
  });
  return asset;
}

/** Uncached equivalent, also useful for reproducible benchmarks. */
export function createMaskAsset(options: SquircleOptions): MaskAsset | null {
  const g = resolveGeometry(options);
  return g.radius === 0 || g.smoothing === 0 ? null : createAsset(g);
}

function trimCache() {
  while (cache.size > MAX_ENTRIES || stringBytes > MAX_STRING_BYTES) {
    const oldest = cache.keys().next().value!;
    stringBytes -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
  }
}

function trackImage(key: string, asset: MaskAsset, image: string) {
  const entry = cache.get(key);
  // Callers may retain an asset after eviction/clear or reinsertion of its key.
  if (entry?.asset !== asset) return;
  const bytes = image.length * 2;
  entry.bytes += bytes;
  stringBytes += bytes;
  if (entry.bytes > MAX_STRING_BYTES) {
    stringBytes -= entry.bytes;
    cache.delete(key);
  } else trimCache();
}

/** Null means a native border-radius is sufficient; do not build an SVG. */
export function getMaskAsset(options: SquircleOptions): MaskAsset | null {
  const g = resolveGeometry(options);
  if (g.radius === 0 || g.smoothing === 0) return null;
  // Use effective geometry so equivalent, clamped requests share an entry.
  const key = `${g.width}/${g.height}/${g.radius}/${g.smoothing}`;
  const existing = cache.get(key);
  if (existing) {
    hits++;
    cache.delete(key);
    cache.set(key, existing);
    return existing.asset;
  }
  misses++;
  const asset = createAsset(g, key);
  const bytes = 2 * (key.length + asset.path.length);
  // An oversized entry is usable, but is not retained.
  if (bytes <= MAX_STRING_BYTES) {
    cache.set(key, { asset, bytes });
    stringBytes += bytes;
    trimCache();
  }
  return asset;
}

export function clearMaskCache(): void {
  cache.clear();
  stringBytes = hits = misses = 0;
}

export function getMaskCacheStats() {
  return {
    entries: cache.size,
    estimatedStringBytes: stringBytes,
    hits,
    misses,
    maxEntries: MAX_ENTRIES,
    maxStringBytes: MAX_STRING_BYTES
  };
}
