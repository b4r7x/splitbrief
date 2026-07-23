import { afterEach, describe, expect, it } from 'vitest';
import { configStore } from '../../src/stores/project/config.js';
import { terminalSizeStore } from '../../src/stores/ui/terminal-size.js';
import { findVisualScenario } from './catalog.js';
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
