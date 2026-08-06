import { afterEach, describe, expect, it } from 'vitest';
import { configStore } from '../../src/stores/project/config.js';
import { terminalSizeStore } from '../../src/stores/ui/terminal-size.js';
import { stripTerminalControls } from '../../src/utils/display-text.js';
import { findVisualScenario, REQUIRED_VIEWPORTS } from './catalog.js';
import { viewport, type Viewport } from './contracts/geometry.js';
import { ArtifactProvenanceSchema } from './contracts/selection.js';
import { teardownVisualFixture } from './fixtures/screen-fixtures.js';
import { mountGalleryScenario } from './gallery/mount.js';
import { parseTerminalFrame } from './terminal/parse.js';
import { createFrameIdentity } from './visual-contract-fixtures.js';

interface GalleryCase {
  readonly scenarioId: string;
  readonly viewport: Viewport;
}

const CASES: readonly GalleryCase[] = [
  { scenarioId: 'home-empty', viewport: viewport({ cols: 120, rows: 40 }) },
  { scenarioId: 'workflow-question', viewport: viewport({ cols: 80, rows: 24 }) },
  { scenarioId: 'overlay-help', viewport: viewport({ cols: 60, rows: 18 }) },
];

afterEach(() => {
  teardownVisualFixture();
});

describe('production App gallery mount', () => {
  it.each(CASES)('captures $scenarioId at its declared viewport', async (galleryCase) => {
    const scenario = requireScenario(galleryCase.scenarioId);
    const checkpoint = requireCheckpoint(scenario);
    const handle = await mountGalleryScenario({
      scenario,
      checkpoint,
      viewport: galleryCase.viewport,
    });

    try {
      const frame = await handle.waitForCheckpoint();
      const provenance = ArtifactProvenanceSchema.parse({
        scenarioId: scenario.id,
        scenarioTitle: scenario.title,
        fixtureVersion: scenario.fixtureVersion,
        checkpointId: checkpoint.id,
        viewport: galleryCase.viewport,
      });
      const grid = await parseTerminalFrame({
        ansi: frame,
        identity: createFrameIdentity(provenance),
        projectRoot: process.cwd(),
      });

      expect(frame).toContain(checkpoint.marker);
      expect(grid.rect).toEqual({
        x: 0,
        y: 0,
        width: galleryCase.viewport.cols,
        height: galleryCase.viewport.rows,
      });
    } finally {
      await handle.unmount();
    }
  });

  it('times out with capture identity and always unmounts', async () => {
    const terminalBefore = terminalSizeStore.get();
    const scenario = requireScenario('home-empty');
    const checkpoint = requireCheckpoint(scenario);
    const handle = await mountGalleryScenario({
      scenario,
      checkpoint,
      viewport: viewport({ cols: 80, rows: 24 }),
    });

    await expect(
      handle.waitForCheckpoint({ predicate: () => false, timeoutMs: 10 }),
    ).rejects.toThrow(
      'Checkpoint ready was not reached for scenario home-empty at 80x24 within 10ms',
    );
    expect(configStore.get().config).toBeNull();
    expect(terminalSizeStore.get()).toEqual(terminalBefore);
    await handle.unmount();
  });
});

describe('workflow chrome spans the declared viewport', () => {
  const NARROWEST_COLS = Math.min(...REQUIRED_VIEWPORTS.map((candidate) => candidate.cols));

  it.each(
    REQUIRED_VIEWPORTS,
  )('workflow-implementation chrome spans the declared $cols x $rows viewport', async (renderViewport) => {
    const scenario = requireScenario('workflow-implementation');
    const checkpoint = requireCheckpoint(scenario);
    const handle = await mountGalleryScenario({
      scenario,
      checkpoint,
      viewport: renderViewport,
    });

    try {
      const rows = frameRows(await handle.waitForCheckpoint());
      const headerDivider = findFullWidthRuleRow(rows, renderViewport.cols, 'first');
      const footerDivider = findFullWidthRuleRow(rows, renderViewport.cols, 'last');
      const composerFrame = findComposerFrameRow(rows, footerDivider);
      const narrowest = renderViewport.cols === NARROWEST_COLS;

      assertChromeRowWidth('header divider', rows, headerDivider, renderViewport, narrowest);
      assertChromeRowWidth('footer divider', rows, footerDivider, renderViewport, narrowest);
      assertChromeRowWidth('composer frame', rows, composerFrame, renderViewport, narrowest);
    } finally {
      await handle.unmount();
    }
  });
});

function assertChromeRowWidth(
  label: string,
  rows: readonly string[],
  rowIndex: number | undefined,
  renderViewport: Viewport,
  narrowest: boolean,
): void {
  if (rowIndex === undefined) {
    expect(
      narrowest,
      `${label} row not found at ${renderViewport.cols}x${renderViewport.rows}`,
    ).toBe(true);
    return;
  }
  const measured = rowCellWidth(rows[rowIndex] ?? '');
  expect(
    measured,
    `${label} row measures ${measured} cells at ${renderViewport.cols}x${renderViewport.rows}, expected ${renderViewport.cols}`,
  ).toBe(renderViewport.cols);
}

const BOX_DRAWING_START_CODE = 0x2500;
const BOX_DRAWING_END_CODE = 0x257f;
const ASCII_BOX_CORNER = '+';

function frameRows(frame: string): string[] {
  const rows = stripTerminalControls(frame, { preserveLineBreaks: true }).split('\n');
  while (rows.length > 0 && rows[rows.length - 1] === '') {
    rows.pop();
  }
  return rows;
}

function rowCellWidth(row: string): number {
  return row.trimEnd().length;
}

function isFullWidthRuleRow(row: string, cols: number): boolean {
  const cells = row.trimEnd();
  if (cells.length !== cols) return false;
  const first = cells[0];
  if (first === undefined || first === ' ') return false;
  for (const cell of cells) {
    if (cell !== first) return false;
  }
  return true;
}

function findFullWidthRuleRow(
  rows: readonly string[],
  cols: number,
  edge: 'first' | 'last',
): number | undefined {
  if (edge === 'first') {
    const index = rows.findIndex((row) => isFullWidthRuleRow(row, cols));
    return index === -1 ? undefined : index;
  }
  let last: number | undefined;
  rows.forEach((row, index) => {
    if (isFullWidthRuleRow(row, cols)) last = index;
  });
  return last;
}

function findComposerFrameRow(
  rows: readonly string[],
  footerDivider: number | undefined,
): number | undefined {
  const start = (footerDivider ?? -1) + 1;
  for (let index = start; index < rows.length; index += 1) {
    const first = firstNonSpaceCell(rows[index] ?? '');
    if (first !== undefined && isBoxDrawingCorner(first)) return index;
  }
  return undefined;
}

function firstNonSpaceCell(row: string): string | undefined {
  const cells = row.trimStart();
  return cells.length > 0 ? cells[0] : undefined;
}

function isBoxDrawingCorner(cell: string): boolean {
  const code = cell.codePointAt(0) ?? 0;
  return (
    (code >= BOX_DRAWING_START_CODE && code <= BOX_DRAWING_END_CODE) || cell === ASCII_BOX_CORNER
  );
}

function requireScenario(id: string) {
  const scenario = findVisualScenario(id);
  if (scenario === undefined) throw new Error(`Missing visual scenario ${id}`);
  return scenario;
}

function requireCheckpoint(scenario: ReturnType<typeof requireScenario>) {
  const checkpoint = scenario.checkpoints[0];
  if (checkpoint === undefined) throw new Error(`Missing checkpoint for ${scenario.id}`);
  return checkpoint;
}
