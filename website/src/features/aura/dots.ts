import { hash } from '../../lib/noise';
import { createTicker } from '../../lib/ticker';

export type Profile = 'skyline' | 'ground' | 'column';
const PROFILES: readonly Profile[] = ['skyline', 'ground', 'column'];
export type FieldSpec = {
  readonly seed: number;
  readonly cols: number;
  readonly rows: number;
  readonly profile: Profile;
};
export type Cell = {
  readonly c: number;
  readonly r: number;
  readonly glyph: '.' | ':';
  readonly alpha: number;
};
const CELL = { width: 7, height: 11 };
const RATE = 4;
const RELIT = 0.05;

function n(u: number, seed: number): number {
  return 0.5 + 0.5 * Math.sin(9.4 * u + seed) * Math.cos(4.1 * u - 0.7 * seed);
}

export function share(profile: Profile, u: number, v: number, seed: number): number {
  if (profile === 'skyline') return 0.61 * (0.25 + 0.75 * n(u, seed)) * v ** 1.6;
  if (profile === 'ground') return 0.43 * (0.4 + 0.6 * n(u, seed)) * v ** 1.2;
  return 0.22 * (0.3 + 0.7 * (1 - Math.abs(u - 0.5) * 2)) * (0.6 + 0.4 * Math.sin(7 * v + seed));
}

function cell(spec: FieldSpec, c: number, r: number, tick: number): Cell {
  return {
    c,
    r,
    alpha: 0.45 + 0.55 * hash(spec.seed, c, r, 4 * tick + 1),
    glyph: hash(spec.seed, c, r, 4 * tick + 2) < 0.3 ? ':' : '.',
  };
}

export function cells(spec: FieldSpec): Cell[] {
  const out: Cell[] = [];
  for (let c = 0; c < spec.cols; c++) {
    for (let r = 0; r < spec.rows; r++) {
      const u = (c + 0.5) / spec.cols;
      const v = (r + 0.5) / spec.rows;
      if (hash(spec.seed, c, r, 0) < share(spec.profile, u, v, spec.seed)) {
        out.push(cell(spec, c, r, 0));
      }
    }
  }
  return out;
}

export function relit(spec: FieldSpec, tick: number): Cell[] {
  const out: Cell[] = [];
  for (let c = 0; c < spec.cols; c++) {
    for (let r = 0; r < spec.rows; r++) {
      const u = (c + 0.5) / spec.cols;
      const v = (r + 0.5) / spec.rows;
      if (hash(spec.seed, c, r, 0) >= share(spec.profile, u, v, spec.seed)) continue;
      if (hash(spec.seed, c, r, 4 * tick + 3) < RELIT) {
        out.push(cell(spec, c, r, tick));
      }
    }
  }
  return out;
}

function isProfile(value: string | undefined): value is Profile {
  return PROFILES.some((profile) => profile === value);
}

export function fieldSpec(canvas: HTMLCanvasElement): FieldSpec {
  const profile = canvas.dataset.profile;
  if (!isProfile(profile)) throw new Error('dots: bad profile');
  return {
    seed: Number(canvas.dataset.seed),
    cols: Number(canvas.dataset.cols),
    rows: Number(canvas.dataset.rows),
    profile,
  };
}

export function mountDots(
  canvas: HTMLCanvasElement,
  spec: FieldSpec,
  ink: string,
): { start(): void; stop(): void } {
  const dpr = Math.min(2, devicePixelRatio);
  canvas.style.width = `${spec.cols * CELL.width}px`;
  canvas.style.height = `${spec.rows * CELL.height}px`;
  canvas.width = spec.cols * CELL.width * dpr;
  canvas.height = spec.rows * CELL.height * dpr;
  const context = canvas.getContext('2d');
  if (context === null) return { start() {}, stop() {} };
  const g = context;
  g.scale(dpr, dpr);
  g.font = '11px "JetBrains Mono"';
  g.textBaseline = 'top';
  g.fillStyle = ink;
  function draw({ c, r, glyph, alpha }: Cell): void {
    g.clearRect(c * CELL.width, r * CELL.height, CELL.width, CELL.height);
    g.globalAlpha = alpha;
    g.fillText(glyph, c * CELL.width, r * CELL.height);
  }
  for (const lit of cells(spec)) draw(lit);
  const ticker = createTicker(canvas, RATE, (t) => {
    for (const lit of relit(spec, Math.round(t * RATE))) draw(lit);
  });
  return { start: ticker.start, stop: ticker.stop };
}
