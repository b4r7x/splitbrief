import { afterEach, describe, expect, it } from 'vitest';
import { createCropCellGrid } from '../artifacts/crop.js';
import { findVisualScenario } from '../catalog.js';
import { viewport } from '../contracts/geometry.js';
import { teardownVisualFixture } from '../fixtures/screen-fixtures.js';
import { mountGalleryScenario } from '../gallery/mount.js';
import { resolveElementLocator } from './resolve.js';
import { createFrameGrid, requireCheckpoint } from './scenario-locators.js';

afterEach(teardownVisualFixture);

describe('plan-card approval crop', () => {
  it.each([60, 80, 120, 160])('includes every action at %s columns', async (cols) => {
    const scenario = findVisualScenario('workflow-plan-card');
    if (scenario === undefined) throw new Error('Missing plan-card scenario');
    const checkpoint = requireCheckpoint(scenario);
    const size = viewport({
      cols,
      rows: cols === 60 ? 18 : cols === 80 ? 24 : cols === 120 ? 40 : 45,
    });
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: size });
    try {
      const frame = await handle.waitForCheckpoint();
      const grid = await createFrameGrid(scenario, size, frame);
      const locator = resolveElementLocator({
        scenario,
        checkpoint,
        grid,
        elementId: 'approval-panel',
      });
      const crop = createCropCellGrid({ frame: grid, locator });
      const text = crop.cells.map((row) => row.map((cell) => cell.grapheme).join('')).join('\n');
      expect(text).toContain('Approve plan and start the build');
      expect(text).toContain('Request changes');
      expect(text).toContain('Edit plan.json');
      expect(text).toContain('End run');
      if (cols >= 120) expect(text).toContain('↑↓ select');
    } finally {
      await handle.unmount();
    }
  });
});
