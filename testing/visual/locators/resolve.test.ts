import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScenarioDefinition } from '../contracts/catalog.js';
import { isCellRectOnGraphemeBoundaries } from '../contracts/cells.js';
import { isCellRectInViewport, viewport } from '../contracts/geometry.js';
import { findVisualScenario, listVisualScenarios } from '../catalog.js';
import { createCropCellGrid } from '../artifacts/crop.js';
import { teardownVisualFixture } from '../fixtures/screen-fixtures.js';
import { mountGalleryScenario } from '../gallery/mount.js';
import { LOCATOR_FAILURE_CODE } from './types.js';
import { LOCATOR_REGISTRY } from './registry.js';
import { resolveElementLocator, tryResolveElementLocator } from './resolve.js';
import {
  createFrameGrid,
  landsTranscript,
  requireCheckpoint,
  SCENARIO_LOCATOR_SHARDS,
  scenarioLocatorShard,
} from './scenario-locators.js';

const ESC = '\u001b';
const VIEWPORT = viewport({ cols: 80, rows: 24 });
const WIDE_VIEWPORT = viewport({ cols: 120, rows: 40 });
const SIDEBAR_VIEWPORT = viewport({ cols: 160, rows: 45 });

function requireScenario(id: string): ScenarioDefinition {
  const scenario = findVisualScenario(id);
  if (scenario === undefined) throw new Error(`Missing visual scenario ${id}`);
  return scenario;
}

describe('semantic visual locators', { timeout: 90_000 }, () => {
  afterEach(teardownVisualFixture);

  it('registers a locator for every catalog element and nothing else', () => {
    const registryKeys = new Set<string>();
    for (const scenario of listVisualScenarios()) {
      const surface = scenario.surface.kind === 'screen' ? scenario.surface.screen : 'overlay';
      for (const element of scenario.elements) registryKeys.add(`${surface}:${element.id}`);
    }

    expect(Object.keys(LOCATOR_REGISTRY).sort()).toEqual([...registryKeys].sort());
  });

  it('mounts every catalog scenario in exactly one resolve-scenarios shard file', () => {
    // resolve-scenarios-<n>.test.ts resolves every element of its scenarios at every viewport
    // against production App frames, and lands each workflow transcript on its budgeted row.
    const shardFiles = readdirSync(import.meta.dirname)
      .filter((name) => /^resolve-scenarios-\d+\.test\.ts$/.test(name))
      .sort();
    const expectedFiles = Array.from(
      { length: SCENARIO_LOCATOR_SHARDS },
      (_, index) => `resolve-scenarios-${index + 1}.test.ts`,
    ).sort();
    expect(shardFiles).toEqual(expectedFiles);

    const scenarios = listVisualScenarios();
    const shards = new Set(scenarios.map((_, index) => scenarioLocatorShard(index)));
    expect([...shards].sort((a, b) => a - b)).toEqual(
      Array.from({ length: SCENARIO_LOCATOR_SHARDS }, (_, index) => index + 1),
    );
    expect(scenarios.some(landsTranscript)).toBe(true);
  });

  it('pins the header, sidebar, composer, approval and hero rects at 80x24 / 120x40 / 160x45', async () => {
    const home = requireScenario('home-empty');
    const homeGrid = await createFrameGrid(home, VIEWPORT, requireCheckpoint(home).marker);
    const header = resolveElementLocator({
      scenario: home,
      checkpoint: requireCheckpoint(home),
      grid: homeGrid,
      elementId: 'header',
    });
    const workflow = requireScenario('workflow-idle');
    const workflowGrid = await createFrameGrid(
      workflow,
      WIDE_VIEWPORT,
      workflow.checkpoints[0]?.marker ?? '',
    );
    const composer = resolveElementLocator({
      scenario: workflow,
      checkpoint: requireCheckpoint(workflow),
      grid: workflowGrid,
      elementId: 'composer',
    });
    const implementation = requireScenario('workflow-implementation');
    // The sidebar stands only above the 120-column breakpoint, so its pin renders at 160x45;
    // the composer keeps its 120x40 grid, where it spans 118 columns inside the gutter.
    const implementationGrid = await createFrameGrid(
      implementation,
      SIDEBAR_VIEWPORT,
      requireCheckpoint(implementation).marker,
    );
    const sidebar = resolveElementLocator({
      scenario: implementation,
      checkpoint: requireCheckpoint(implementation),
      grid: implementationGrid,
      elementId: 'sidebar',
    });

    const review = requireScenario('workflow-review');
    const reviewCheckpoint = requireCheckpoint(review);
    const reviewGrid = await createFrameGrid(
      review,
      VIEWPORT,
      `${ESC}[10;5H${reviewCheckpoint.marker}`,
    );
    const approval = resolveElementLocator({
      scenario: review,
      checkpoint: reviewCheckpoint,
      grid: reviewGrid,
      elementId: 'approval-panel',
    });

    // At 80x24 the home body is 76 cols wide ('wide' overlay width) centred at x=2,
    // and 11 rows tall: full-tier logo (6) + trailing gap row (1) + seat block (4).
    expect(header).toMatchObject({
      kind: 'layout',
      rect: { x: 2, y: 0, width: 76, height: 11 },
    });
    expect(sidebar.kind).toBe('layout');
    // The sidebar and the composer are boxes on the one-cell gutter line, with the same gap kept
    // on the right.
    expect(sidebar.rect.x).toBe(1);
    expect(composer).toMatchObject({
      kind: 'layout',
      rect: { x: 1, y: 36, width: 118, height: 3 },
    });
    expect(approval).toMatchObject({
      kind: 'layout',
      rect: { x: 0, width: 80 },
    });
    expect(approval.rect.y + approval.rect.height).toBe(18);
    expect(approval.provenance).toMatchObject({
      scenarioId: review.id,
      scenarioTitle: review.title,
      checkpointId: reviewCheckpoint.id,
      viewport: VIEWPORT,
      sourceFrameKey: reviewGrid.identity.key,
    });
  });

  it('resolves every moved-model-line element at 100x30', async () => {
    const scenario = requireScenario('workflow-ready-seat-moved-model-line');
    const checkpoint = requireCheckpoint(scenario);
    const frameViewport = viewport({ cols: 100, rows: 30 });
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: frameViewport });
    try {
      const frame = await handle.waitForCheckpoint();
      const grid = await createFrameGrid(scenario, frameViewport, frame);
      const header = resolveElementLocator({ scenario, checkpoint, grid, elementId: 'header' });
      const sidebar = resolveElementLocator({ scenario, checkpoint, grid, elementId: 'sidebar' });
      for (const locator of [header, sidebar]) {
        expect(isCellRectInViewport(locator.rect, frameViewport)).toBe(true);
        expect(isCellRectOnGraphemeBoundaries(grid.cells, locator.rect)).toBe(true);
        expect(createCropCellGrid({ frame: grid, locator }).rect).toEqual(locator.rect);
      }
      expect(sidebar.rect).toEqual(header.rect);
      expect(header.rect).toMatchObject({ x: 0, y: 0 });
    } finally {
      await handle.unmount();
    }
  });

  it.each([VIEWPORT, WIDE_VIEWPORT, viewport({ cols: 60, rows: 18 })])(
    'crops the ASCII home composer and its completion menu at $cols x $rows',
    async (frameViewport) => {
      const scenario = requireScenario('home-skills-completion');
      const checkpoint = requireCheckpoint(scenario);
      const handle = await mountGalleryScenario({
        scenario,
        checkpoint,
        viewport: frameViewport,
        profile: 'ascii-mono',
      });
      try {
        const frame = await handle.waitForCheckpoint();
        const grid = await createFrameGrid(scenario, frameViewport, frame);
        const cropRows = (elementId: string) => {
          const locator = resolveElementLocator({ scenario, checkpoint, grid, elementId });
          return createCropCellGrid({ frame: grid, locator }).cells.map((row) =>
            row.map((cell) => cell.grapheme).join(''),
          );
        };
        const composer = cropRows('composer');
        expect(composer.at(-3)).toMatch(/^\+-+\+$/);
        expect(composer.at(-2)).toContain('> /skills');
        expect(composer.at(-1)).toMatch(/^\+-+\+$/);
        const menu = cropRows('completion');
        expect(menu[0]).toMatch(/^\+-+\+$/);
        expect(menu.at(-2)).toContain('tab fill');
        expect(menu.at(-1)).toMatch(/^\+-+\+$/);
      } finally {
        await handle.unmount();
      }
    },
  );

  it('reports invalid names and cross-frame provenance failures', async () => {
    const review = requireScenario('workflow-review');
    const checkpoint = requireCheckpoint(review);
    const duplicateGrid = await createFrameGrid(
      review,
      VIEWPORT,
      `${ESC}[5;3H${checkpoint.marker}${ESC}[10;3H${checkpoint.marker}`,
    );
    expect(
      tryResolveElementLocator({
        scenario: review,
        checkpoint,
        grid: duplicateGrid,
        elementId: '../approval-panel',
      }),
    ).toMatchObject({ ok: false, failure: { code: LOCATOR_FAILURE_CODE.invalidName } });

    const idle = requireScenario('workflow-idle');
    const idleGrid = await createFrameGrid(idle, VIEWPORT, requireCheckpoint(idle).marker);
    const planning = requireScenario('workflow-planning');
    expect(
      tryResolveElementLocator({
        scenario: planning,
        checkpoint: requireCheckpoint(planning),
        grid: idleGrid,
        elementId: 'sidebar',
      }),
    ).toMatchObject({ ok: false, failure: { code: LOCATOR_FAILURE_CODE.crossFrame } });
  });

  it('resolves the output-token recovery panel when its checkpoint marker repeats or is truncated', async () => {
    const scenario = requireScenario('workflow-recovery-plan-output-limit');
    const checkpoint = requireCheckpoint(scenario);
    const viewports = [
      viewport({ cols: 120, rows: 40 }),
      viewport({ cols: 80, rows: 24 }),
      viewport({ cols: 60, rows: 18 }),
      viewport({ cols: 160, rows: 45 }),
    ];

    for (const frameViewport of viewports) {
      const handle = await mountGalleryScenario({
        scenario,
        checkpoint,
        viewport: frameViewport,
      });
      try {
        const frame = await handle.waitForCheckpoint();
        const grid = await createFrameGrid(scenario, frameViewport, frame);
        const locator = resolveElementLocator({
          scenario,
          checkpoint,
          grid,
          elementId: 'question-panel',
        });
        const crop = createCropCellGrid({ frame: grid, locator });
        const text = crop.cells.map((row) => row.map((cell) => cell.grapheme).join('')).join('\n');
        expect(text).toContain('Try again');
        expect(text).toContain('Change PLAN tool');
        expect(text).toContain('End run');
      } finally {
        await handle.unmount();
      }
    }
  });

  it.each(
    [
      { id: 'workflow-question-input', count: 'Question 1 of 2' },
      { id: 'workflow-question-overflow', count: 'Question 2 of 3' },
    ].flatMap(({ id, count }) =>
      [VIEWPORT, WIDE_VIEWPORT, SIDEBAR_VIEWPORT, viewport({ cols: 60, rows: 18 })].map(
        (frameViewport) => ({ id, count, frameViewport }),
      ),
    ),
  )(
    'crops the whole $id question panel at $frameViewport.cols x $frameViewport.rows',
    async ({ id, count, frameViewport }) => {
      const scenario = requireScenario(id);
      const checkpoint = requireCheckpoint(scenario);
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: frameViewport });
      try {
        const frame = await handle.waitForCheckpoint();
        const grid = await createFrameGrid(scenario, frameViewport, frame);
        const locator = resolveElementLocator({
          scenario,
          checkpoint,
          grid,
          elementId: 'question-panel',
        });
        const rows = createCropCellGrid({ frame: grid, locator }).cells.map((row) =>
          row.map((cell) => cell.grapheme).join(''),
        );
        expect(rows[0]).toMatch(/^\s*┌/);
        expect(rows.join('\n')).toContain(count);
        expect(rows.at(-1)).toMatch(/^\s*└/);
      } finally {
        await handle.unmount();
      }
    },
  );
});
