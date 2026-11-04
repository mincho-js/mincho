import { expect, it } from "vitest";
import { getSquircleShape, getSquirclePath } from "./geometry.js";

type Point = [number, number];

// Resolve one shape() coordinate for an axis of `length` CSS px.
function resolve(value: string, length: number): number {
  if (value === "0") return 0;
  if (value === "100%") return length;
  const start = /^min\(([\d.e-]+)px, 50%\)$/.exec(value);
  if (start) return Math.min(Number(start[1]), length / 2);
  const end = /^calc\(100% - min\(([\d.e-]+)px, 50%\)\)$/.exec(value);
  if (end) return length - Math.min(Number(end[1]), length / 2);
  throw new Error(`Unexpected coordinate: ${value}`);
}

// Points in SVG order: control points before each cubic's end point.
function shapePoints(shape: string, width: number, height: number): Point[] {
  const body = /^shape\((.*)\)$/.exec(shape)![1];
  const point = (text: string): Point => {
    const [x, y] = text.match(
      /calc\(100% - min\([^)]*\)\)|min\([^)]*\)|100%|\b0\b/g
    )!;
    return [resolve(x, width), resolve(y, height)];
  };
  const points: Point[] = [];
  for (const command of body.split(/, (?=line|curve|arc|close)/)) {
    let match: RegExpExecArray | null;
    if ((match = /^(?:from|line to) (.+)$/.exec(command)))
      points.push(point(match[1]));
    else if ((match = /^curve to (.+) with (.+) \/ (.+)$/.exec(command)))
      points.push(point(match[2]), point(match[3]), point(match[1]));
    else if ((match = /^arc to (.+) of [\d.]+px cw$/.exec(command)))
      points.push(point(match[1]));
    else expect(command).toBe("close");
  }
  return points;
}

// Absolute points; relative commands are offsets from the segment start.
function pathPoints(path: string): Point[] {
  const points: Point[] = [];
  let [x, y]: Point = [0, 0];
  for (const [, command, args] of path.matchAll(/([MLCAZ])([^MLCAZ]*)/gi)) {
    const n = args.trim().split(/[ ,]+/).filter(Boolean).map(Number);
    const xy = command.toUpperCase() === "A" ? n.slice(5) : n;
    const [ox, oy] = command === command.toLowerCase() ? [x, y] : [0, 0];
    for (let i = 0; i < xy.length; i += 2)
      points.push([ox + xy[i], oy + xy[i + 1]]);
    if (xy.length) [x, y] = points.at(-1)!;
  }
  return points;
}

it.each([
  [300, 200, 20, 0.8],
  [96, 96, 24, 1],
  [400, 120, 36, 0.6],
  [180, 64, 20, 0.6]
])(
  "matches the measured path for an unclamped %sx%s box (r=%s, s=%s)",
  (width, height, radius, smoothing) => {
    const shape = getSquircleShape({ radius, smoothing })!;
    const expected = pathPoints(
      getSquirclePath({ width, height, radius, smoothing })
    );
    const actual = shapePoints(shape, width, height);
    expect(actual).toHaveLength(expected.length);
    actual.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(expected[i][0], 3);
      expect(y).toBeCloseTo(expected[i][1], 3);
    });
  }
);

it("keeps clamped boxes within the border box", () => {
  const shape = getSquircleShape({ radius: 40, smoothing: 1 })!;
  for (const [x, y] of shapePoints(shape, 60, 50)) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(60);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(50);
  }
});

it("returns null when native rounded corners suffice", () => {
  expect(getSquircleShape({ radius: 0 })).toBeNull();
  expect(getSquircleShape({ smoothing: 0 })).toBeNull();
  expect(() => getSquircleShape({ radius: Infinity })).toThrow(RangeError);
});
