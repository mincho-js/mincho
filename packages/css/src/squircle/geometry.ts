/** Figma's final cubic–arc–cubic construction, not a superellipse. */
export interface SquircleOptions {
  width: number;
  height: number;
  radius?: number;
  smoothing?: number;
}

export interface Geometry {
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly smoothing: number;
  readonly p: number;
}

export function finiteNonnegative(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return Math.max(0, value);
}

export function normalizeRadius(radius = 24): number {
  return finiteNonnegative(radius, "radius");
}

export function normalizeSmoothing(smoothing = 0.6): number {
  return Math.min(1, finiteNonnegative(smoothing, "smoothing"));
}

export function resolveGeometry(options: SquircleOptions): Geometry {
  const width = finiteNonnegative(options.width, "width");
  const height = finiteNonnegative(options.height, "height");
  const requestedRadius = normalizeRadius(options.radius);
  const requestedSmoothing = normalizeSmoothing(options.smoothing);
  const budget = Math.min(width, height) / 2;
  const radius = Math.min(requestedRadius, budget);
  // Preserve radius until smoothing has fallen to zero.
  const smoothing =
    radius === 0
      ? 0
      : Math.min(requestedSmoothing, Math.max(0, budget / radius - 1));
  return { width, height, radius, smoothing, p: (1 + smoothing) * radius };
}

export interface Corner {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly alpha: number;
}

export function getCorner(radius: number, smoothing: number): Corner {
  const alpha = (Math.PI * smoothing) / 4;
  const t = radius * Math.tan(alpha / 2);
  const b = (radius * smoothing + t) / 3;
  return {
    a: 2 * b,
    b,
    c: t * Math.cos(alpha),
    d: t * Math.sin(alpha),
    alpha
  };
}

// Round coordinates, not input sizes or cache keys. Keep sub-0.0001px values
// representable rather than rounding a tiny, nonzero radius down to zero.
const number = (n: number): string => {
  if (n === 0) return "0";
  return Math.abs(n) < 0.0001
    ? String(+n.toPrecision(6))
    : String(+n.toFixed(4));
};

/** Pure, uncached path generator. Empty boxes have an empty path. */
export function getSquirclePath(options: SquircleOptions): string {
  return pathFromGeometry(resolveGeometry(options));
}

export function pathFromGeometry(g: Geometry): string {
  const { width: w, height: h, radius: r, smoothing: s, p } = g;
  if (w === 0 || h === 0) return "";
  if (r === 0) return `M0 0H${number(w)}V${number(h)}H0Z`;

  if (s === 0) {
    const arc = `A${number(r)} ${number(r)} 0 0 1 `;
    return (
      `M${number(r)} 0H${number(w - r)}` +
      arc +
      `${number(w)} ${number(r)}V${number(h - r)}` +
      arc +
      `${number(w - r)} ${number(h)}H${number(r)}` +
      arc +
      `0 ${number(h - r)}V${number(r)}` +
      arc +
      `${number(r)} 0Z`
    );
  }

  // Corners are relative and size-independent; absolute edges reset rounding
  // drift at every corner. A new size formats only four numbers.
  const k = getCorners(r, s);
  return (
    `M${number(w - p)} 0${k.corners[0]}` +
    `L${number(w)} ${number(h - p)}${k.corners[1]}` +
    `L${k.p} ${number(h)}${k.corners[2]}` +
    `L0 ${k.p}${k.corners[3]}Z`
  );
}

interface Corners {
  readonly p: string;
  readonly corners: readonly [string, string, string, string];
}

// Resizes reuse one entry; clamped boxes and slider sweeps create new keys.
const MAX_CORNERS = 64;
const cornerCache = new Map<string, Corners>();

function getCorners(r: number, s: number): Corners {
  const key = `${r}/${s}`;
  let k = cornerCache.get(key);
  if (k === undefined) {
    if (cornerCache.size >= MAX_CORNERS)
      cornerCache.delete(cornerCache.keys().next().value!);
    k = relativeCorners(r, s);
    cornerCache.set(key, k);
  }
  return k;
}

function relativeCorners(r: number, s: number): Corners {
  const p = (1 + s) * r;
  // One set of trigonometric evaluations for all four corners.
  const { a, b, c, d } = getCorner(r, s);
  const ab = a + b;
  const abc = ab + c;
  // The second cubic starts where the arc ends. At s=1 the arc disappears, so
  // it starts where the first cubic ends; do not emit a degenerate SVG arc.
  const [x, y] = s < 1 ? [p - d, p - abc] : [abc, d];
  const corner = (rotation: number): string => {
    // Rotate a canonical top-right delta clockwise by 90° per corner.
    const delta = (dx: number, dy: number): string => {
      switch (rotation) {
        case 0:
          return `${number(dx)} ${number(dy)}`;
        case 1:
          return `${number(-dy)} ${number(dx)}`;
        case 2:
          return `${number(-dx)} ${number(-dy)}`;
        default:
          return `${number(dy)} ${number(-dx)}`;
      }
    };
    const arc =
      s < 1 ? `a${number(r)} ${number(r)} 0 0 1 ${delta(x - abc, y - d)}` : "";
    return (
      `c${delta(a, 0)} ${delta(ab, 0)} ${delta(abc, d)}${arc}` +
      `c${delta(p - x, p - ab - y)} ${delta(p - x, p - a - y)} ${delta(p - x, p - y)}`
    );
  };
  return {
    p: number(p),
    corners: [corner(0), corner(1), corner(2), corner(3)]
  };
}

// Offsets from the start (left/top) or end (right/bottom) edge. Clamping to
// half the axis keeps boxes below the smoothing budget from self-intersecting
// before an exact measured path replaces them.
const fromStart = (v: number): string =>
  v === 0 ? "0" : `min(${number(v)}px, 50%)`;
const fromEnd = (v: number): string =>
  v === 0 ? "100%" : `calc(100% - min(${number(v)}px, 50%))`;

function shapeFromCorner(r: number, s: number): string {
  const p = (1 + s) * r;
  const { a, b, c, d } = getCorner(r, s);
  const ab = a + b;
  const abc = ab + c;
  // Same canonical top-right corner as pathFromGeometry, in edge offsets.
  const point = (corner: number, x: number, y: number): string => {
    switch (corner) {
      case 0:
        return `${fromEnd(p - x)} ${fromStart(y)}`;
      case 1:
        return `${fromEnd(y)} ${fromEnd(p - x)}`;
      case 2:
        return `${fromStart(p - x)} ${fromEnd(y)}`;
      default:
        return `${fromStart(y)} ${fromStart(p - x)}`;
    }
  };
  const parts: string[] = [`from ${point(0, 0, 0)}`];
  for (let corner = 0; corner < 4; corner++) {
    if (corner !== 0) parts.push(`line to ${point(corner, 0, 0)}`);
    parts.push(
      `curve to ${point(corner, abc, d)} with ${point(corner, a, 0)} / ${point(corner, ab, 0)}`
    );
    if (s < 1)
      parts.push(
        `arc to ${point(corner, p - d, p - abc)} of ${number(r)}px cw`
      );
    parts.push(
      `curve to ${point(corner, p, p)} with ${point(corner, p, p - ab)} / ${point(corner, p, p - a)}`
    );
  }
  parts.push("close");
  return `shape(${parts.join(", ")})`;
}

// Every responsive element with the same corner shares one string. Slider
// sweeps create new keys, so keep the cache small and bounded.
const MAX_SHAPES = 32;
const shapes = new Map<string, string>();

/**
 * Size-independent CSS `shape()` for `clip-path`, exact when both axes are at
 * least `2p`. Null means a native border-radius is sufficient.
 *
 * Browsers without CSS `shape()` drop this declaration. Direct callers must
 * provide a `border-radius` fallback and use `@supports` or `CSS.supports` to
 * enable the clip and reset `border-radius` to 0 when supported.
 */
export function getSquircleShape(
  options: Pick<SquircleOptions, "radius" | "smoothing"> = {}
): string | null {
  const r = normalizeRadius(options.radius);
  const s = normalizeSmoothing(options.smoothing);
  if (r === 0 || s === 0) return null;
  const key = `${r}/${s}`;
  let shape = shapes.get(key);
  if (shape === undefined) {
    if (shapes.size >= MAX_SHAPES) shapes.delete(shapes.keys().next().value!);
    shape = shapeFromCorner(r, s);
    shapes.set(key, shape);
  }
  return shape;
}
