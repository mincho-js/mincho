import { it as test, vi } from "vitest";
import assert from "node:assert/strict";
import { getCorner, getSquirclePath, resolveGeometry } from "./geometry.js";
import {
  clearMaskCache,
  createMaskAsset,
  getMaskAsset,
  getMaskCacheStats
} from "./mask-cache.js";
const close = (a: number, b: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test("zero radius uses a rectangular path and no SVG asset", () => {
  const options = { width: 100, height: 80, radius: 0 };
  assert.equal(getSquirclePath(options), "M0 0H100V80H0Z");
  assert.equal(getMaskAsset(options), null);
});
test("zero smoothing uses circular corners and no mask asset", () => {
  const options = { width: 100, height: 80, radius: 20, smoothing: 0 };
  assert.equal((getSquirclePath(options).match(/A/gi) ?? []).length, 4);
  assert.equal(getMaskAsset(options), null);
});
test("smoothing is reduced before radius", () => {
  const cases = [
    [80, 20, 0.6],
    [60, 20, 0.5],
    [40, 20, 0],
    [20, 10, 0]
  ];
  for (const [height, radius, smoothing] of cases) {
    const g = resolveGeometry({
      width: 100,
      height,
      radius: 20,
      smoothing: 0.6
    });
    close(g.radius, radius);
    close(g.smoothing, smoothing);
  }
});
test("full smoothing eliminates all four arcs, retaining eight cubics", () => {
  const path = getSquirclePath({
    width: 200,
    height: 100,
    radius: 20,
    smoothing: 1
  });
  assert.equal((path.match(/A/gi) ?? []).length, 0);
  assert.equal((path.match(/C/gi) ?? []).length, 8);
});
test("ordinary smoothing has eight cubics and four arcs", () => {
  const path = getSquirclePath({
    width: 200,
    height: 100,
    radius: 20,
    smoothing: 0.6
  });
  assert.equal((path.match(/A/gi) ?? []).length, 4);
  assert.equal((path.match(/C/gi) ?? []).length, 8);
});
test("relative corners trace the absolute construction", () => {
  // Independent absolute reference: [x, y] after each command, in order.
  const reference = (w: number, h: number, r: number, s: number) => {
    const g = resolveGeometry({ width: w, height: h, radius: r, smoothing: s });
    const { a, b, c, d } = getCorner(g.radius, g.smoothing);
    const { p } = g;
    const points: [number, number][] = [];
    for (let corner = 0; corner < 4; corner++) {
      const point = (x: number, y: number): [number, number] =>
        [
          [w - p + x, y],
          [w - y, h - p + x],
          [p - x, h - y],
          [y, p - x]
        ][corner] as [number, number];
      points.push(point(0, 0), point(a, 0), point(a + b, 0));
      points.push(point(a + b + c, d));
      if (g.smoothing < 1) points.push(point(p - d, p - a - b - c));
      points.push(point(p, p - a - b), point(p, p - a), point(p, p));
    }
    return points;
  };
  const traced = (path: string) => {
    const points: [number, number][] = [];
    let [x, y] = [0, 0];
    for (const [, command, args] of path.matchAll(/([MLCAZ])([^MLCAZ]*)/gi)) {
      const n = args.trim().split(" ").filter(Boolean).map(Number);
      const xy = command.toUpperCase() === "A" ? n.slice(5) : n;
      const [ox, oy] = command === command.toLowerCase() ? [x, y] : [0, 0];
      for (let i = 0; i < xy.length; i += 2)
        points.push([ox + xy[i], oy + xy[i + 1]]);
      if (xy.length) [x, y] = points.at(-1)!;
    }
    return points;
  };
  for (const [w, h, r, s] of [
    [300, 200, 20, 0.6],
    [250.375, 160.125, 24, 1],
    [100, 60, 20, 0.9],
    [80, 400, 36, 0.8],
    [1200.5, 33.3, 12, 0.25]
  ]) {
    const actual = traced(
      getSquirclePath({ width: w, height: h, radius: r, smoothing: s })
    );
    const expected = reference(w, h, r, s);
    assert.equal(actual.length, expected.length);
    actual.forEach(([x, y], i) => {
      close(x, expected[i][0], 1e-3);
      close(y, expected[i][1], 1e-3);
    });
  }
});
test("corner endpoints lie on the fixed-radius circle and meet it tangentially", () => {
  for (const r of [0.2, 1, 20, 100])
    for (const s of [0.01, 0.2, 0.6, 1]) {
      const { a, b, c, d, alpha } = getCorner(r, s);
      const p = (1 + s) * r;
      close(a, 2 * b);
      close(a + b + c, p - r + r * Math.sin(alpha));
      close(d, r * (1 - Math.cos(alpha)));
      close(Math.hypot(a + b + c - (p - r), d - r), r);
      close(c * Math.sin(alpha) - d * Math.cos(alpha), 0);
    }
});
test("empty dimensions have an empty path, not NaN coordinates", () => {
  assert.equal(getSquirclePath({ width: 0, height: 100 }), "");
  assert.equal(getMaskAsset({ width: 100, height: 0 }), null);
});
test("negative values clamp and nonfinite values reject", () => {
  assert.equal(resolveGeometry({ width: -1, height: 10 }).width, 0);
  assert.equal(
    resolveGeometry({ width: 100, height: 100, smoothing: -4 }).smoothing,
    0
  );
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => getSquirclePath({ width: value, height: 100 }),
      RangeError
    );
    assert.throws(
      () => getMaskAsset({ width: 100, height: 100, radius: value }),
      RangeError
    );
  }
});
test("fractional sizes and tiny nonzero radii produce finite paths", () => {
  for (const radius of [1e-7, 0.5, 20.25, 200]) {
    const path = getSquirclePath({ width: 250.375, height: 160.125, radius });
    assert.ok(!/NaN|Infinity/.test(path));
    assert.ok(path.endsWith("Z"));
  }
});
test("same geometry reuses the entire immutable encoded SVG asset", () => {
  clearMaskCache();
  const options = { width: 320, height: 200, radius: 24, smoothing: 0.6 };
  const first = getMaskAsset(options);
  assert.equal(first, getMaskAsset({ ...options }));
  assert.ok(Object.isFrozen(first));
  assert.equal(getMaskCacheStats().hits, 1);
  assert.equal(getMaskCacheStats().misses, 1);
});
test("different requests that clamp to equal geometry share the asset", () => {
  clearMaskCache();
  const a = getMaskAsset({
    width: 100,
    height: 60,
    radius: 20,
    smoothing: 0.6
  });
  const b = getMaskAsset({
    width: 100,
    height: 60,
    radius: 20,
    smoothing: 0.9
  });
  assert.equal(a, b);
});
test("cache count and estimated string memory remain bounded under resizing", () => {
  clearMaskCache();
  for (let width = 200; width < 2000; width++)
    getMaskAsset({ width, height: 160 });
  const stats = getMaskCacheStats();
  assert.ok(stats.entries <= stats.maxEntries);
  assert.ok(stats.estimatedStringBytes <= stats.maxStringBytes);
});
test("cached asset and uncached reference have identical paths and SVG bytes", () => {
  for (let i = 0; i < 60; i++) {
    const options = {
      width: 128 + i / 10,
      height: 140,
      radius: 24,
      smoothing: i / 59
    };
    assert.deepEqual(getMaskAsset(options), createMaskAsset(options));
  }
});
test("encoded SVG round-trips and contains no external resource reference", () => {
  const asset = getMaskAsset({ width: 320, height: 200 })!;
  const svg = decodeURIComponent(
    asset.image.slice('url("data:image/svg+xml,'.length, -2)
  );
  assert.ok(svg.includes('viewBox="0 0 320 200"'));
  assert.ok(svg.includes(`d="${asset.path}"`));
  assert.ok(!/href=|<script|<foreignObject/.test(svg));
});

test("path-only consumers skip SVG encoding and image access is memoized", () => {
  clearMaskCache();
  const encode = vi.spyOn(globalThis, "encodeURIComponent");
  try {
    const asset = getMaskAsset({ width: 320, height: 200 })!;
    assert.ok(asset.path);
    assert.equal(encode.mock.calls.length, 0);
    const before = getMaskCacheStats().estimatedStringBytes;
    const image = asset.image;
    assert.equal(encode.mock.calls.length, 1);
    assert.equal(asset.image, image);
    assert.equal(encode.mock.calls.length, 1);
    assert.equal(
      getMaskCacheStats().estimatedStringBytes,
      before + image.length * 2
    );
  } finally {
    encode.mockRestore();
  }
});

test("lazy image allocation respects the byte limit and evicted asset identity", () => {
  clearMaskCache();
  const options = { width: 320, height: 200 };
  const retained = getMaskAsset(options)!;
  for (let width = 1000; width < 1200; width++)
    getMaskAsset({ width, height: 200 });
  const replacement = getMaskAsset(options)!;
  assert.notEqual(retained, replacement);
  const before = getMaskCacheStats().estimatedStringBytes;
  void retained.image;
  assert.equal(getMaskCacheStats().estimatedStringBytes, before);
  void replacement.image;
  assert.equal(
    getMaskCacheStats().estimatedStringBytes,
    before + replacement.image.length * 2
  );
  // Retained references may materialize an image after their cache entry leaves.
  const assets = Array.from({ length: 200 }, (_, i) =>
    getMaskAsset({ width: 1e20 + i * 32768, height: 1e20, radius: 1e19 })!
  );
  const entries = getMaskCacheStats().entries;
  for (const asset of assets) {
    void asset.image;
    const stats = getMaskCacheStats();
    assert.ok(stats.estimatedStringBytes <= stats.maxStringBytes);
    assert.ok(stats.estimatedStringBytes >= 0);
  }
  assert.ok(getMaskCacheStats().entries < entries);
  const unread = getMaskAsset({ width: 340, height: 200 })!;
  clearMaskCache();
  void unread.image;
  assert.equal(getMaskCacheStats().estimatedStringBytes, 0);
});
