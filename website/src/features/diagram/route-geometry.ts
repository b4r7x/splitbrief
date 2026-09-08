export type Point = { readonly x: number; readonly y: number };
export type Polyline = readonly [Point, ...Point[]];

export function length(points: Polyline): number {
  let sum = 0;
  let last = points[0];
  for (const p of points) {
    sum += Math.hypot(p.x - last.x, p.y - last.y);
    last = p;
  }
  return sum;
}

export function pointAt(points: Polyline, distance: number): Point {
  let left = distance;
  let last = points[0];
  for (const p of points.slice(1)) {
    const step = Math.hypot(p.x - last.x, p.y - last.y);
    if (left <= step) {
      return {
        x: last.x + ((p.x - last.x) * left) / step,
        y: last.y + ((p.y - last.y) * left) / step,
      };
    }
    left -= step;
    last = p;
  }
  return last;
}

export function parsePath(d: string): Polyline {
  const points: Point[] = [];
  for (const [, x, y] of d.matchAll(/(-?\d*\.?\d+)[\s,]+(-?\d*\.?\d+)/g)) {
    points.push({ x: Number(x), y: Number(y) });
  }
  const [first, ...rest] = points;
  if (!first) throw new Error(`route path has no points: ${d}`);
  return [first, ...rest];
}

function reversed(points: Polyline): Polyline {
  const [first, ...rest] = points;
  const [head, ...tail] = [...rest].reverse();
  return head ? [head, ...tail, first] : points;
}

function pushedStart(points: Polyline, by: number): Polyline {
  const [first, second, ...rest] = points;
  if (!second) return points;
  const step = Math.hypot(second.x - first.x, second.y - first.y);
  const start = {
    x: first.x - ((second.x - first.x) / step) * by,
    y: first.y - ((second.y - first.y) / step) * by,
  };
  return [start, second, ...rest];
}

export function extend(points: Polyline, by: number): Polyline {
  return reversed(pushedStart(reversed(pushedStart(points, by)), by));
}

export function offsetPath(points: Polyline): string {
  const moves = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  return `path("${moves.join(' ')}")`;
}
