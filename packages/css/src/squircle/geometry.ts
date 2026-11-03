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

  // One set of trigonometric evaluations for all four corners.
  const { a, b, c, d } = getCorner(r, s);
  const ab = a + b;
  const abc = ab + c;
  const arc = `A${number(r)} ${number(r)} 0 0 1 `;
  const parts: string[] = [`M${number(w - p)} 0`];

  for (let corner = 0; corner < 4; corner++) {
    // Map a canonical top-right corner to each actual corner.
    const point = (x: number, y: number): string => {
      switch (corner) {
        case 0:
          return `${number(w - p + x)} ${number(y)}`;
        case 1:
          return `${number(w - y)} ${number(h - p + x)}`;
        case 2:
          return `${number(p - x)} ${number(h - y)}`;
        default:
          return `${number(y)} ${number(p - x)}`;
      }
    };
    if (corner !== 0) parts.push(`L${point(0, 0)}`);
    parts.push(`C${point(a, 0)} ${point(ab, 0)} ${point(abc, d)}`);
    // At s=1 the arc disappears. Do not emit a degenerate SVG arc.
    if (s < 1) parts.push(`${arc}${point(p - d, p - abc)}`);
    parts.push(`C${point(p, p - ab)} ${point(p, p - a)} ${point(p, p)}`);
  }
  parts.push("Z");
  return parts.join("");
}
