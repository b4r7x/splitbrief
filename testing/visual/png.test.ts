import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { CellGrid } from './contracts/cells.js';
import { viewport } from './contracts/geometry.js';
import { createFrameIdentity, createVisualProvenance } from './visual-contract-fixtures.js';
import { parseTerminalFrame } from './terminal/parse.js';
import { serializeTerminalTruth } from './terminal/serialize.js';
import { PNG_RENDERER_METADATA, renderCellGridPng } from './artifacts/png.js';
import { renderCellGridSvg, SVG_CELL_HEIGHT_PX, SVG_CELL_WIDTH_PX } from './artifacts/svg.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('cell-grid PNG rendering', () => {
  it('returns a PNG whose signature and dimensions derive from cell metrics', async () => {
    const grid = await createGrid();
    const result = await renderCellGridPng({ grid, svg: renderCellGridSvg(grid) });
    if (result.kind !== 'success') throw new Error('Expected sharp rasterization to succeed');
    const metadata = await sharp(result.bytes).metadata();

    expect(Array.from(result.bytes.slice(0, PNG_SIGNATURE.length))).toEqual(PNG_SIGNATURE);
    expect(result.dimensions).toEqual({
      widthPx: grid.rect.width * SVG_CELL_WIDTH_PX,
      heightPx: grid.rect.height * SVG_CELL_HEIGHT_PX,
    });
    expect(metadata).toMatchObject({
      format: 'png',
      width: result.dimensions.widthPx,
      height: result.dimensions.heightPx,
    });
  });

  it('reports pinned renderer, font, and cell-metric metadata', async () => {
    const grid = await createGrid();
    const result = await renderCellGridPng({ grid, svg: renderCellGridSvg(grid) });
    if (result.kind !== 'success') throw new Error('Expected sharp rasterization to succeed');

    expect(result.renderer).toEqual(PNG_RENDERER_METADATA);
    expect(result.renderer).toMatchObject({
      name: 'sharp',
      version: sharp.versions.sharp,
      cellWidthPx: SVG_CELL_WIDTH_PX,
      cellHeightPx: SVG_CELL_HEIGHT_PX,
    });
    expect(result.renderer.fontFamily).toContain('monospace');
  });

  it('returns one structured PNG failure while diagnostic truth remains available', async () => {
    const grid = await createGrid();
    const diagnostic = serializeTerminalTruth(grid);
    const result = await renderCellGridPng({
      grid,
      svg: renderCellGridSvg(grid),
      rasterize: async () => {
        throw new Error('forced rasterizer failure');
      },
    });

    expect(result).toEqual({
      kind: 'failure',
      failure: {
        stage: 'png',
        code: 'png-raster-failed',
        message: 'PNG rasterization failed for the selected artifact',
        artifact: grid.identity,
      },
    });
    expect(serializeTerminalTruth(grid)).toEqual(diagnostic);
    expect(diagnostic.ansi).not.toHaveLength(0);
    expect(diagnostic.txt).not.toHaveLength(0);
    expect(diagnostic.cellsJson).not.toHaveLength(0);
  });
});

async function createGrid(): Promise<CellGrid> {
  const provenance = createVisualProvenance(viewport({ cols: 12, rows: 2 }));
  return parseTerminalFrame({
    ansi: '\u001b[1;36mRaster fixture\u001b[0m',
    identity: createFrameIdentity(provenance),
    projectRoot: process.cwd(),
  });
}
