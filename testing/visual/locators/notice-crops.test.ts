import { afterEach, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { createCropCellGrid } from '../artifacts/crop.js';
import { findVisualScenario } from '../catalog.js';
import { viewport } from '../contracts/geometry.js';
import { teardownVisualFixture } from '../fixtures/screen-fixtures.js';
import { mountGalleryScenario } from '../gallery/mount.js';
import { resolveElementLocator } from './resolve.js';
import { createFrameGrid, requireCheckpoint } from './scenario-locators.js';

afterEach(teardownVisualFixture);

it('fills the save notice and keeps discovery above it', async () => {
  const scenario = findVisualScenario('home-cold-detecting-save-sign-in');
  if (scenario === undefined) throw new Error('Missing discovery scenario');
  const size = viewport({ cols: 60, rows: 18 });
  const handle = await mountGalleryScenario({
    scenario,
    checkpoint: requireCheckpoint(scenario),
    viewport: size,
  });
  try {
    const grid = await createFrameGrid(scenario, size, await handle.waitForCheckpoint());
    const rows = grid.cells.map((row) => row.map((cell) => cell.grapheme).join(''));
    const save = rows.findIndex((row) => row.includes('Saved BUILD'));
    expect(rows[save - 1]).toContain('Checking your tools');
    expect(grid.cells[save]?.[rows[save]?.indexOf('Saved') ?? -1]?.background.kind).toBe('rgb');
    expect(rows[rows.findIndex((row) => row.includes('before start')) + 1]?.trim()).toMatch(
      /^╭─+╮$/u,
    );
  } finally {
    await handle.unmount();
  }
});

it('captures the centered preparation notice, its key legend and the composer', async () => {
  const scenario = findVisualScenario('home-preparation-failed');
  if (!scenario) throw new Error('Missing preparation scenario');
  const checkpoint = requireCheckpoint(scenario);
  const size = viewport({ cols: 120, rows: 40 });
  const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: size });
  try {
    const grid = await createFrameGrid(scenario, size, await handle.waitForCheckpoint());
    const locator = resolveElementLocator({
      scenario,
      checkpoint,
      grid,
      elementId: 'preparation-notice',
    });
    const crop = createCropCellGrid({ frame: grid, locator });
    const lines = crop.cells.map((row) => row.map((cell) => cell.grapheme).join(''));
    expect(lines[0]).toContain('try again');
    const notice = lines[1] ?? '';
    const composer = lines.findLast((line) => line.includes('╭')) ?? '';
    expect(composer.trim()).toMatch(/^╭─+╮$/u);
    expect(notice.trim().length).toBeLessThan(composer.trim().length);
    for (const row of [lines[0] ?? '', notice]) {
      const left = row.length - row.trimStart().length;
      const right = row.length - row.trimEnd().length;
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
    }
  } finally {
    await handle.unmount();
  }
});

it('keeps the frame around a shortened, clickable draft path', async () => {
  const scenario = findVisualScenario('home-draft-not-saved');
  if (!scenario) throw new Error('Missing draft scenario');
  const size = viewport({ cols: 60, rows: 18 });
  const handle = await mountGalleryScenario({
    scenario,
    checkpoint: requireCheckpoint(scenario),
    viewport: size,
  });
  try {
    const grid = await createFrameGrid(scenario, size, await handle.waitForCheckpoint());
    const row = grid.cells.find((cells) =>
      cells.some((cell) => cell.hyperlink?.kind === 'project-file'),
    );
    expect(
      row
        ?.filter((cell) => cell.hyperlink)
        .map((cell) => cell.grapheme)
        .join(''),
    ).toBe('.splitbrief/…/draft.json');
    expect(
      row
        ?.map((cell) => cell.grapheme)
        .join('')
        .trimEnd(),
    ).toMatch(/draft\.json · +│$/u);
  } finally {
    await handle.unmount();
  }
});

describe.each([
  ['workflow-command-image-refused', 'header', /Build[^\n]*PLAN claude/u],
  ['workflow-ready-seat-moved-auto', 'header', /PLAN codex.*BUILD agy.*REVIEW codex/u],
  ['workflow-closed-undone', 'transcript', /Crew.*PLAN/su],
  ['workflow-plan-card-usage-refused', 'approval-panel', /End run/u],
  ['home-recent-cursor', 'header', /PLAN cursor.*BUILD cursor.*REVIEW cursor/su],
  ['home-recent-check-failed', 'composer', /Tool check failed/su],
  ['home-recent-selection-error', 'composer', /✗ Apply is still writing/su],
  ['home-cold-failed', 'composer', /Tool check failed/u],
  ['home-kilo-routes', 'header', /REVIEW/u],
  ['home-no-config-long-draft', 'heading', /^\s*splitbrief\s*$/u],
  ['home-save-long-draft', 'heading', /^\s*splitbrief\s*$/u],
] as const)('%s at 60 columns', (id, elementId, expected) => {
  it('captures the complete ' + elementId, async () => {
    const scenario = findVisualScenario(id);
    if (scenario === undefined) throw new Error(id);
    const checkpoint = requireCheckpoint(scenario);
    const size = viewport({ cols: 60, rows: 18 });
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: size });
    try {
      const frame = await handle.waitForCheckpoint();
      const grid = await createFrameGrid(scenario, size, frame);
      const locator = resolveElementLocator({ scenario, checkpoint, grid, elementId });
      const crop = createCropCellGrid({ frame: grid, locator });
      const text = crop.cells.map((row) => row.map((cell) => cell.grapheme).join('')).join('\n');
      expect(text).toMatch(expected);
      if (id === 'workflow-plan-card-usage-refused') {
        expect(stripAnsiStyles(frame)).toContain(
          'Add a greeting module and expose it from the CLI.',
        );
        expect(text).not.toContain('╭');
      }
    } finally {
      await handle.unmount();
    }
  });
});
