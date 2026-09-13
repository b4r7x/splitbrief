import { describe, expect, it } from 'vitest';
import { isCellRectOnGraphemeBoundaries, type CellGrid } from '../contracts/cells.js';
import type { CheckpointDefinition, ScenarioDefinition } from '../contracts/catalog.js';
import { isCellRectInViewport, viewport, type Viewport } from '../contracts/geometry.js';
import { ArtifactProvenanceSchema } from '../contracts/selection.js';
import { findVisualScenario, listVisualScenarios } from '../catalog.js';
import { createCropCellGrid } from '../artifacts/crop.js';
import { mountGalleryScenario } from '../gallery/mount.js';
import { parseTerminalFrame } from '../terminal/parse.js';
import { createFrameIdentity } from '../visual-contract-fixtures.js';
import { LOCATOR_FAILURE_CODE } from './types.js';
import { LOCATOR_REGISTRY } from './registry.js';
import { resolveElementLocator, tryResolveElementLocator } from './resolve.js';

const ESC = '\u001b';
const VIEWPORT = viewport({ cols: 80, rows: 24 });
const WIDE_VIEWPORT = viewport({ cols: 120, rows: 40 });

function requireScenario(id: string): ScenarioDefinition {
  const scenario = findVisualScenario(id);
  if (scenario === undefined) throw new Error(`Missing visual scenario ${id}`);
  return scenario;
}

function requireCheckpoint(scenario: ScenarioDefinition): CheckpointDefinition {
  const checkpoint = scenario.checkpoints[0];
  if (checkpoint === undefined) throw new Error(`Missing checkpoint for ${scenario.id}`);
  return checkpoint;
}

async function createFrameGrid(
  scenario: ScenarioDefinition,
  frameViewport: Viewport,
  ansi: string,
): Promise<CellGrid> {
  const checkpoint = requireCheckpoint(scenario);
  const provenance = ArtifactProvenanceSchema.parse({
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    fixtureVersion: scenario.fixtureVersion,
    checkpointId: checkpoint.id,
    viewport: frameViewport,
  });
  return parseTerminalFrame({
    ansi,
    identity: createFrameIdentity(provenance),
    projectRoot: process.cwd(),
  });
}

describe('semantic visual locators', { timeout: 90_000 }, () => {
  it('resolves every catalog element at every viewport against production App frames', async () => {
    let resolvedCount = 0;
    const registryKeys = new Set<string>();

    for (const scenario of listVisualScenarios()) {
      const checkpoint = requireCheckpoint(scenario);
      const surface = scenario.surface.kind === 'screen' ? scenario.surface.screen : 'overlay';
      for (const element of scenario.elements) registryKeys.add(`${surface}:${element.id}`);

      for (const frameViewport of scenario.viewports) {
        const handle = await mountGalleryScenario({
          scenario,
          checkpoint,
          viewport: frameViewport,
        });
        try {
          let frame: string;
          try {
            frame = await handle.waitForCheckpoint();
          } catch (error) {
            const message = error instanceof Error ? error.message : 'checkpoint wait failed';
            throw new Error(`${message}\nLast frame:\n${handle.lastFrame() ?? '<empty>'}`);
          }
          const grid = await createFrameGrid(scenario, frameViewport, frame);

          for (const element of scenario.elements) {
            const label = `${scenario.id}/${frameViewport.cols}x${frameViewport.rows}/${element.id}`;
            const result = tryResolveElementLocator({
              scenario,
              checkpoint,
              grid,
              elementId: element.id,
            });
            if (!result.ok) {
              throw new Error(`${label}: ${result.failure.code}: ${result.failure.message}`);
            }

            expect(isCellRectInViewport(result.locator.rect, frameViewport), label).toBe(true);
            expect(isCellRectOnGraphemeBoundaries(grid.cells, result.locator.rect), label).toBe(
              true,
            );
            expect(result.locator.provenance, label).toEqual({
              ...grid.identity.provenance,
              sourceFrameKey: grid.identity.key,
            });
            let crop: CellGrid;
            try {
              crop = createCropCellGrid({ frame: grid, locator: result.locator });
            } catch (error) {
              const message = error instanceof Error ? error.message : 'crop creation failed';
              throw new Error(`${label}: ${message}`);
            }
            expect(crop.rect, label).toEqual(result.locator.rect);
            resolvedCount += 1;
          }
        } finally {
          await handle.unmount();
        }
      }
    }

    expect(Object.keys(LOCATOR_REGISTRY).sort()).toEqual([...registryKeys].sort());
    expect(resolvedCount).toBe(
      listVisualScenarios().reduce(
        (total, scenario) => total + scenario.elements.length * scenario.viewports.length,
        0,
      ),
    );
  }, 120_000);

  it('pins the header, sidebar, composer, approval and hero rects at 80x24 / 120x40', async () => {
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
    const implementationGrid = await createFrameGrid(
      implementation,
      WIDE_VIEWPORT,
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

    const summary = requireScenario('summary-success');
    const summaryCheckpoint = requireCheckpoint(summary);
    const summaryGrid = await createFrameGrid(
      summary,
      VIEWPORT,
      `${ESC}[2;4H${summaryCheckpoint.marker}`,
    );
    const hero = resolveElementLocator({
      scenario: summary,
      checkpoint: summaryCheckpoint,
      grid: summaryGrid,
      elementId: 'summary-hero',
    });

    // At 80x24 the home body is 76 cols wide ('wide' overlay width) centred at x=2,
    // and 11 rows tall: full-tier logo (6) + trailing gap row (1) + seat block (4).
    expect(header).toMatchObject({
      kind: 'layout',
      rect: { x: 2, y: 0, width: 76, height: 11 },
    });
    expect(sidebar.kind).toBe('layout');
    expect(sidebar.rect.x).toBe(0);
    expect(composer).toMatchObject({
      kind: 'layout',
      rect: { x: 0, y: 36, width: 120, height: 3 },
    });
    expect(approval).toMatchObject({
      kind: 'marker',
      rect: { x: 0, y: 7, width: 80, height: 5 },
    });
    expect(hero).toMatchObject({
      kind: 'marker',
      rect: { x: 0, y: 0, width: 80, height: 4 },
    });

    expect(approval.provenance).toMatchObject({
      scenarioId: review.id,
      scenarioTitle: review.title,
      checkpointId: reviewCheckpoint.id,
      viewport: VIEWPORT,
      sourceFrameKey: reviewGrid.identity.key,
    });
  });

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
});
