import { afterEach, describe, expect, it } from 'vitest';
import { configStore } from '../../src/stores/project/config.js';
import { WORKFLOW_GUTTER_X } from '../../src/features/workflow/layout/chrome-rows.js';
import { terminalSizeStore } from '../../src/stores/ui/terminal-size.js';
import { stripTerminalControls } from '../../src/utils/display-text.js';
import { formatElapsedClock } from '../../src/utils/format-time.js';
import { findVisualScenario, REQUIRED_VIEWPORTS } from './catalog.js';
import { viewport, type Viewport } from './contracts/geometry.js';
import { ArtifactProvenanceSchema } from './contracts/selection.js';
import { teardownVisualFixture } from './fixtures/screen-fixtures.js';
import { VISUAL_FIXTURE_EPOCH } from './fixtures/common.js';
import { FIXED_CLOCK } from './gallery/environment.js';
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
  { scenarioId: 'workflow-recovery-balance-spent', viewport: viewport({ cols: 80, rows: 24 }) },
  { scenarioId: 'workflow-crew-wide', viewport: viewport({ cols: 200, rows: 50 }) },
  { scenarioId: 'home-cold-crew', viewport: viewport({ cols: 200, rows: 50 }) },
  { scenarioId: 'workflow-stop-sheet-recovery', viewport: viewport({ cols: 80, rows: 24 }) },
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

  it.each(['unicode-color', 'unicode-256', 'unicode-light'] as const)(
    'captures colour under the %s profile',
    async (profile) => {
      const scenario = requireScenario('overlay-planner-picker');
      const checkpoint = requireCheckpoint(scenario);
      const captureViewport = viewport({ cols: 120, rows: 40 });
      const handle = await mountGalleryScenario({
        scenario,
        checkpoint,
        viewport: captureViewport,
        profile,
      });

      try {
        const frame = await handle.waitForCheckpoint();
        const provenance = ArtifactProvenanceSchema.parse({
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          fixtureVersion: scenario.fixtureVersion,
          checkpointId: checkpoint.id,
          viewport: captureViewport,
        });
        const grid = await parseTerminalFrame({
          ansi: frame,
          identity: createFrameIdentity(provenance),
          projectRoot: process.cwd(),
        });

        expect(grid.cells.flat().some((cell) => cell.foreground.kind !== 'default')).toBe(true);
      } finally {
        await handle.unmount();
      }
    },
  );

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

// The capture clock stands past the fixture epoch, so every live clock has counted. A clock set
// before the runs it paints clamps them all to 0:00 and the gallery can guard none of them.
describe('the capture clock', () => {
  const counted = formatElapsedClock(Date.parse(FIXED_CLOCK) - VISUAL_FIXTURE_EPOCH);

  it.each([
    { scenarioId: 'workflow-planning' },
    { scenarioId: 'workflow-implementation' },
    { scenarioId: 'workflow-recovery-usage-limit' },
  ])('paints the counted run clock on $scenarioId', async ({ scenarioId }) => {
    const scenario = requireScenario(scenarioId);
    const checkpoint = requireCheckpoint(scenario);
    const handle = await mountGalleryScenario({
      scenario,
      checkpoint,
      viewport: viewport({ cols: 120, rows: 40 }),
    });

    try {
      const frame = await handle.waitForCheckpoint();
      const rows = frameRows(frame);
      expect(counted).not.toBe('0:00');
      expect(rows[0] ?? '').toContain(counted);
      // The checkpoint's own state is on screen with the counted clock, not only the header.
      expect(frame).toContain(checkpoint.marker);
    } finally {
      await handle.unmount();
    }
  });
});

describe('workflow chrome spans the declared viewport', () => {
  it.each(REQUIRED_VIEWPORTS)(
    'workflow-implementation chrome spans the declared $cols x $rows viewport',
    async (renderViewport) => {
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

        assertChromeRowWidth('header divider', rows, headerDivider, renderViewport);
        assertChromeRowWidth('footer divider', rows, footerDivider, renderViewport);
        assertGutterBoxRow('composer frame', rows, composerFrame, renderViewport);
      } finally {
        await handle.unmount();
      }
    },
  );
});

function assertChromeRowWidth(
  label: string,
  rows: readonly string[],
  rowIndex: number | undefined,
  renderViewport: Viewport,
): void {
  expect(
    rowIndex,
    `${label} row not found at ${renderViewport.cols}x${renderViewport.rows}`,
  ).not.toBeUndefined();
  const row = rows[rowIndex ?? -1] ?? '';
  const measured = rowCellWidth(row);
  expect(
    measured,
    `${label} row measures ${measured} cells at ${renderViewport.cols}x${renderViewport.rows}, expected ${renderViewport.cols}`,
  ).toBe(renderViewport.cols);
  // The rule bleeds: its first cell is painted, not a frame cell.
  expect(row[0]).not.toBe(' ');
}

// A box stands on the gutter line and keeps the same gap from the right edge.
function assertGutterBoxRow(
  label: string,
  rows: readonly string[],
  rowIndex: number | undefined,
  renderViewport: Viewport,
): void {
  expect(
    rowIndex,
    `${label} row not found at ${renderViewport.cols}x${renderViewport.rows}`,
  ).not.toBeUndefined();
  const row = rows[rowIndex ?? -1] ?? '';
  const expected = renderViewport.cols - WORKFLOW_GUTTER_X;
  expect(row.search(/\S/), `${label} row leaves the gutter line at ${renderViewport.cols}`).toBe(
    WORKFLOW_GUTTER_X,
  );
  expect(
    rowCellWidth(row),
    `${label} row ends at ${rowCellWidth(row)} cells at ${renderViewport.cols}x${renderViewport.rows}, expected ${expected}`,
  ).toBe(expected);
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

// The chrome rules bleed edge to edge: a rule row trims to exactly cols cells, every one the rule
// glyph, with no frame cell in front of it.
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
