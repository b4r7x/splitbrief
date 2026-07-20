import { describe, expect, it } from 'vitest';
import { CellGridSchema, type CellGrid } from './contracts/cells.js';
import { viewport } from './contracts/geometry.js';
import {
  createCropIdentity,
  createFrameIdentity,
  createVisualProvenance,
} from './visual-contract-fixtures.js';
import { parseTerminalFrame } from './terminal/parse.js';
import {
  getSvgDimensions,
  renderCellGridSvg,
  SVG_CELL_HEIGHT_PX,
  SVG_CELL_WIDTH_PX,
} from './artifacts/svg.js';

const ESC = '\u001b';

describe('cell-grid SVG rendering', () => {
  it('declares pixel dimensions and renders escaped text, backgrounds, and styles', async () => {
    const grid = await createFrameGrid(`${ESC}[1;3;4;9;38;2;12;34;56;48;2;65;43;21mA${ESC}[0m<&>`);
    const svg = renderCellGridSvg(grid);
    const dimensions = getSvgDimensions(grid);

    expect(dimensions).toEqual({
      widthPx: grid.rect.width * SVG_CELL_WIDTH_PX,
      heightPx: grid.rect.height * SVG_CELL_HEIGHT_PX,
    });
    expect(svg).toContain(`width="${dimensions.widthPx}" height="${dimensions.heightPx}"`);
    expect(svg).toContain(`viewBox="0 0 ${dimensions.widthPx} ${dimensions.heightPx}"`);
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&gt;');
    expect(svg).toContain('fill="#412b15"');
    expect(svg).toContain('fill="#0c2238"');
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('font-style="italic"');
    expect(svg).toContain('text-decoration="underline line-through"');
  });

  it('uses the crop cell rectangle for SVG dimensions', async () => {
    const frame = await createFrameGrid('0123456789');
    const crop = createCropGrid(frame, { x: 2, y: 0, width: 5, height: 1 });
    const svg = renderCellGridSvg(crop);

    expect(getSvgDimensions(crop)).toEqual({ widthPx: 40, heightPx: 16 });
    expect(svg).toContain('width="40" height="16" viewBox="0 0 40 16"');
    expect(svg).toContain('data-source-kind="crop"');
  });

  it('is byte-deterministic for the same cell grid', async () => {
    const grid = await createFrameGrid(`${ESC}[36mStable${ESC}[0m output`);

    expect(renderCellGridSvg(grid)).toBe(renderCellGridSvg(grid));
  });

  it('keeps hostile fixture text inert and emits no interactive external URL', async () => {
    const hostile = '<script src="https://openai.com/docs">owned</script><image href="x">';
    const svg = renderCellGridSvg(await createFrameGrid(hostile));

    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<image');
    expect(svg).not.toMatch(/\s(?:href|src|xlink:href)=/u);
    expect(svg).not.toContain('https://openai.com/docs');
    expect(svg).not.toContain('owned</script>');
    expect(svg).toContain('&lt;');
  });
});

async function createFrameGrid(ansi: string): Promise<CellGrid> {
  const provenance = createVisualProvenance(viewport({ cols: 80, rows: 2 }));
  return parseTerminalFrame({
    ansi,
    identity: createFrameIdentity(provenance),
    projectRoot: process.cwd(),
  });
}

function createCropGrid(
  frame: CellGrid,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): CellGrid {
  return CellGridSchema.parse({
    ...frame,
    identity: createCropIdentity(frame.identity.provenance),
    rect,
    cells: frame.cells
      .slice(rect.y, rect.y + rect.height)
      .map((row) => row.slice(rect.x, rect.x + rect.width)),
  });
}
