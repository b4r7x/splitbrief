import { describe, expect, it } from 'vitest';
import { isCellRectOnGraphemeBoundaries, type CellGrid } from '../contracts/cells.js';
import type { CheckpointDefinition, ScenarioDefinition } from '../contracts/catalog.js';
import { isCellRectInViewport, type Viewport } from '../contracts/geometry.js';
import { ArtifactProvenanceSchema } from '../contracts/selection.js';
import { listVisualScenarios } from '../catalog.js';
import { createCropCellGrid } from '../artifacts/crop.js';
import { mountGalleryScenario } from '../gallery/mount.js';
import { parseTerminalFrame } from '../terminal/parse.js';
import { readConversationHoverSnapshot } from '../../../src/features/workflow/layout/snapshot.js';
import { createFrameIdentity } from '../visual-contract-fixtures.js';
import { resolveElementLocator, tryResolveElementLocator } from './resolve.js';

/**
 * Mounting the App for every scenario at every viewport is the heaviest CPU
 * work in `npm test`. The scenarios are dealt round-robin over this many
 * `resolve-scenarios-<n>.test.ts` files so the pool runs them side by side.
 */
export const SCENARIO_LOCATOR_SHARDS = 6;

export function scenarioLocatorShard(index: number): number {
  return (index % SCENARIO_LOCATOR_SHARDS) + 1;
}

export function requireCheckpoint(scenario: ScenarioDefinition): CheckpointDefinition {
  const checkpoint = scenario.checkpoints[0];
  if (checkpoint === undefined) throw new Error(`Missing checkpoint for ${scenario.id}`);
  return checkpoint;
}

export async function createFrameGrid(
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

/** A workflow scenario that names a transcript, whose body row the mounted screen budgets. */
export function landsTranscript(scenario: ScenarioDefinition): boolean {
  return (
    scenario.surface.kind === 'screen' &&
    scenario.surface.screen === 'workflow' &&
    scenario.elements.some((element) => element.id === 'transcript')
  );
}

async function resolveScenarioLocators(scenario: ScenarioDefinition): Promise<void> {
  const checkpoint = requireCheckpoint(scenario);
  let resolvedCount = 0;
  for (const frameViewport of scenario.viewports) {
    const viewportLabel = `${scenario.id}/${frameViewport.cols}x${frameViewport.rows}`;
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: frameViewport });
    let frame: string;
    let paintedBodyTop: number | undefined;
    try {
      try {
        frame = await handle.waitForCheckpoint();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'checkpoint wait failed';
        throw new Error(`${message}\nLast frame:\n${handle.lastFrame() ?? '<empty>'}`);
      }
      // The body top the mounted screen's own snapshot derives from its stores (1-based rect
      // convention); the locator counts the 0-based rows the frame artifacts use.
      if (landsTranscript(scenario)) {
        paintedBodyTop = readConversationHoverSnapshot().contentRect.top - 1;
      }
    } finally {
      await handle.unmount();
    }

    let grid: CellGrid;
    try {
      grid = await createFrameGrid(scenario, frameViewport, frame);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'frame grid failed';
      throw new Error(`${viewportLabel}: ${message}\nFrame:\n${frame}`);
    }

    for (const element of scenario.elements) {
      const label = `${viewportLabel}/${element.id}`;
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
      expect(isCellRectOnGraphemeBoundaries(grid.cells, result.locator.rect), label).toBe(true);
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

    if (paintedBodyTop !== undefined) {
      const transcript = resolveElementLocator({
        scenario,
        checkpoint,
        grid,
        elementId: 'transcript',
      });
      expect(transcript.rect.y, viewportLabel).toBe(paintedBodyTop);
    }
  }
  expect(resolvedCount).toBe(scenario.elements.length * scenario.viewports.length);
}

/**
 * Resolves every element of every scenario in `shard` at every viewport against production App
 * frames, and lands each workflow transcript on the body row the mounted screen budgeted.
 */
export function describeScenarioLocators(shard: number): void {
  const scenarios = listVisualScenarios().filter(
    (_, index) => scenarioLocatorShard(index) === shard,
  );
  describe(`semantic visual locators · shard ${shard} of ${SCENARIO_LOCATOR_SHARDS}`, {
    timeout: 90_000,
  }, () => {
    it('owns at least one scenario', () => {
      expect(scenarios.length).toBeGreaterThan(0);
    });

    for (const scenario of scenarios) {
      it(`resolves every element of ${scenario.id} at every viewport`, () =>
        resolveScenarioLocators(scenario));
    }
  });
}
