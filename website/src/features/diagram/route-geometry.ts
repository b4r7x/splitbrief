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

export function offsetPath(points: Polyline): string {
  const moves = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  return `path("${moves.join(' ')}")`;
}
