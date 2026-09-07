import { hash } from '../../lib/noise';
import type { ScatterPoint } from './scatter';
import { CELL_HEIGHT, CELL_WIDTH } from './seats';

const SEED = 17;
const GLYPHS = '.:';
const COLUMN = { top: 51.6, bottom: 150.5, cells: 6, lit: { top: 0.36, bottom: 0.2 } };
const GLYPH_LAYER = -1;
const SPEED = 14;

export function rainPoints(xs: readonly number[], generation = 0): ScatterPoint[] {
  const rows = Math.floor((COLUMN.bottom - COLUMN.top) / CELL_HEIGHT);
  const points: ScatterPoint[] = [];
  xs.forEach((x, column) => {
    const left = x - (COLUMN.cells * CELL_WIDTH) / 2;
    for (let r = 0; r < rows; r++) {
      const lit = COLUMN.lit.top + ((COLUMN.lit.bottom - COLUMN.lit.top) * r) / (rows - 1);
      for (let c = 0; c < COLUMN.cells; c++) {
        const born = r - generation;
        if (hash(SEED, c, born, column) >= lit) continue;
        const glyph = GLYPHS.charAt(
          Math.floor(hash(SEED, c, born, GLYPH_LAYER - column) * GLYPHS.length),
        );
        points.push({ x: left + c * CELL_WIDTH, y: COLUMN.top + r * CELL_HEIGHT, glyph });
      }
    }
  });
  return points;
}

export function rainPhase(t: number): { generation: number; offset: number } {
  const fallen = Math.floor(t * SPEED);
  return { generation: Math.floor(fallen / CELL_HEIGHT), offset: fallen % CELL_HEIGHT };
}
