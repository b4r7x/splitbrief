export type Vector = readonly [number, number, number];
export type Part = 'left' | 'right' | 'slash';
export type Point = {
  start: Vector;
  end: Vector;
  part: Part;
  tone: number;
  edge: boolean;
  glyph: string;
  phase: number;
};

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const vector = (a: Vector, b: Vector): Vector => [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
const unit = (v: Vector): Vector => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};
const cross = (a: Vector, b: Vector): Vector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function surfaceBasis(a: Vector, b: Vector) {
  const tangent = unit(vector(a, b));
  const normal = unit(cross(tangent, Math.abs(tangent[2]) < 0.95 ? [0, 0, 1] : [0, 1, 0]));
  return { normal, otherNormal: unit(cross(tangent, normal)) };
}

function surface(
  a: Vector,
  b: Vector,
  { normal, otherNormal }: ReturnType<typeof surfaceBasis>,
  width: number,
  depth: number,
  u: number,
  v: number,
  face: number,
): Vector {
  const side = face < 2 ? (face === 0 ? -0.5 : 0.5) * width : (v - 0.5) * width;
  const other = face < 2 ? (v - 0.5) * depth : (face === 2 ? -0.5 : 0.5) * depth;
  return [
    mix(a[0], b[0], u) + normal[0] * side + otherNormal[0] * other,
    mix(a[1], b[1], u) + normal[1] * side + otherNormal[1] * other,
    mix(a[2], b[2], u) + normal[2] * side + otherNormal[2] * other,
  ];
}

function beam(
  points: Point[],
  part: Part,
  a: Vector,
  b: Vector,
  width: number,
  depth: number,
  c: Vector,
  d: Vector,
  endWidth: number,
  endDepth: number,
  brightness = 0,
) {
  const along = Math.ceil(Math.max(Math.hypot(...vector(a, b)), Math.hypot(...vector(c, d))) * 18);
  const across = Math.ceil(Math.max(width, depth, endWidth, endDepth) * 14);
  const startBasis = surfaceBasis(a, b);
  const endBasis = surfaceBasis(c, d);
  const faces = [
    { tone: 1, glyph: ':' },
    { tone: 3, glyph: '#' },
    { tone: 4, glyph: 'H' },
    { tone: 2, glyph: '+' },
  ];
  for (const [face, { tone, glyph }] of faces.entries()) {
    for (let i = 0; i <= along; i += 1) {
      for (let j = 0; j <= across; j += 1) {
        const u = i / along;
        const v = j / across;
        const edge = j === 0 || j === across || i === 0 || i === along;
        points.push({
          start: surface(a, b, startBasis, width, depth, u, v, face),
          end: surface(c, d, endBasis, endWidth, endDepth, u, v, face),
          part,
          tone: tone + brightness,
          edge,
          glyph: edge ? '#' : glyph,
          phase: u * 4 + v,
        });
      }
    }
  }
}

function cableHeight(x: number) {
  return Math.abs(x) <= 8.2 ? 0.7 + 4.9 * (x / 8.2) ** 2 : 5.6 - (Math.abs(x) - 8.2) * 1.1;
}

export function buildPoints(): Point[] {
  const points: Point[] = [];
  for (const sign of [-1, 1]) {
    const x = sign * 8.2;
    const part = sign < 0 ? 'left' : 'right';
    const source: [Vector, Vector, Vector, Vector] = [
      [x, -5.4, 1.35],
      [x, 5.8, 1.35],
      [x, 5.8, -1.35],
      [x, -5.4, -1.35],
    ];
    const destination: [Vector, Vector, Vector, Vector] = [
      [sign * 5.8, -5.4, 0.35],
      [sign * 8.3, -5.4, 0.35],
      [sign * 8.3, 5.4, 0.35],
      [sign * 5.8, 5.4, 0.35],
    ];
    for (const index of [0, 1, 2] as const) {
      const next = index === 0 ? 1 : index === 1 ? 2 : 3;
      beam(
        points,
        part,
        source[index],
        source[next],
        0.48,
        0.52,
        destination[index],
        destination[next],
        0.95,
        1.25,
        sign < 0 ? 0 : 1,
      );
    }
  }
  beam(
    points,
    'slash',
    [-13.8, -0.12, 0],
    [13.8, -0.12, 0],
    0.4,
    3,
    [-4.3, -6.2, 0.6],
    [4.3, 6.2, 0.6],
    1.1,
    1.25,
    1,
  );
  for (const side of [-1, 1]) {
    for (let i = 0; i <= 780; i += 1) {
      const u = i / 780;
      const x = mix(-13.1, 13.1, u);
      const y = cableHeight(x);
      for (let strand = 0; strand < 4; strand += 1) {
        points.push({
          start: [x, y + strand * 0.027, side * 1.47],
          end: [
            mix(-4.3, 4.3, u) + side * 0.42,
            mix(-6.2, 6.2, u) - side * 0.28,
            0.95 + strand * 0.035,
          ],
          part: 'slash',
          tone: side > 0 ? 6 : 3,
          edge: true,
          glyph: '#',
          phase: u * 8,
        });
      }
    }
    for (let i = 0; i <= 64; i += 1) {
      const u = i / 64;
      const x = mix(-12.8, 12.8, u);
      const y = cableHeight(x);
      for (let j = 0; j <= 75; j += 1) {
        const v = j / 75;
        points.push({
          start: [x, mix(0.1, y, v), side * 1.4],
          end: [
            mix(-4.3, 4.3, u) + side * 0.45 * v,
            mix(-6.2, 6.2, u) - side * 0.31 * v,
            0.7 + v * 0.55,
          ],
          part: 'slash',
          tone: side > 0 ? 3 : 1,
          edge: false,
          glyph: ':',
          phase: u * 8 + v,
        });
      }
    }
  }
  for (let i = 0; i <= 66; i += 1) {
    const u = i / 66;
    for (let j = 0; j <= 42; j += 1) {
      const v = j / 42;
      points.push({
        start: [mix(-13.8, 13.8, u), 0.13, mix(-1.5, 1.5, v)],
        end: [mix(-4.3, 4.3, u) + (v - 0.5) * 0.88, mix(-6.2, 6.2, u) - (v - 0.5) * 0.6, 1.25],
        part: 'slash',
        tone: 5,
        edge: true,
        glyph: '=',
        phase: u * 8,
      });
    }
  }
  return points;
}
