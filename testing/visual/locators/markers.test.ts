import { describe, expect, it } from 'vitest';
import { findVisualScenario } from '../catalog.js';
import type { CheckpointDefinition, ScenarioDefinition } from '../contracts/catalog.js';
import type { CellGrid } from '../contracts/cells.js';
import { viewport, type Viewport } from '../contracts/geometry.js';
import { ArtifactProvenanceSchema } from '../contracts/selection.js';
import { parseTerminalFrame } from '../terminal/parse.js';
import { createFrameIdentity } from '../visual-contract-fixtures.js';
import { clipCellRect, resolveMarkerRect } from './markers.js';
import { LOCATOR_FAILURE_CODE } from './types.js';
import { tryResolveElementLocator } from './resolve.js';

const ESC = '\u001b';
const VIEWPORT = viewport({ cols: 80, rows: 24 });

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

describe('visual locator markers and bounds', () => {
  it('reports ambiguity, absence, and clips explicit bounds', async () => {
    const review = requireScenario('workflow-review');
    const checkpoint = requireCheckpoint(review);
    const duplicateGrid = await createFrameGrid(
      review,
      VIEWPORT,
      `${ESC}[5;3H${checkpoint.marker}${ESC}[10;3H${checkpoint.marker}`,
    );
    const duplicate = tryResolveElementLocator({
      scenario: review,
      checkpoint,
      grid: duplicateGrid,
      elementId: 'approval-panel',
    });
    expect(duplicate).toEqual({
      ok: false,
      failure: {
        code: LOCATOR_FAILURE_CODE.ambiguous,
        message: 'Marker has 2 matches in its bounded region',
        elementId: 'approval-panel',
      },
    });
    expect(
      resolveMarkerRect({
        grid: duplicateGrid,
        marker: checkpoint.marker,
        bounds: duplicateGrid.rect,
        selection: { kind: 'index', index: 1 },
      }),
    ).toEqual({ x: 2, y: 9, width: checkpoint.marker.length, height: 1 });

    const emptyGrid = await createFrameGrid(review, VIEWPORT, 'no matching checkpoint');
    expect(
      tryResolveElementLocator({
        scenario: review,
        checkpoint,
        grid: emptyGrid,
        elementId: 'approval-panel',
      }),
    ).toMatchObject({ ok: false, failure: { code: LOCATOR_FAILURE_CODE.notFound } });

    expect(
      clipCellRect({ x: 75, y: 22, width: 20, height: 10 }, { x: 0, y: 0, width: 80, height: 24 }),
    ).toEqual({ x: 75, y: 22, width: 5, height: 2 });
    expectLocatorError(
      () =>
        clipCellRect({ x: -1, y: 0, width: 2, height: 1 }, { x: 0, y: 0, width: 80, height: 24 }),
      LOCATOR_FAILURE_CODE.invalidGeometry,
    );
  });
});

function expectLocatorError(run: () => unknown, name: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw error;
    expect(error.name).toBe(name);
    return;
  }
  throw new Error(`Expected locator error ${name}`);
}
