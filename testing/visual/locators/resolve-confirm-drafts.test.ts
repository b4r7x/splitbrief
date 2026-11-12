import { afterEach, describe, expect, it } from 'vitest';
import { createCropCellGrid } from '../artifacts/crop.js';
import { findVisualScenario, REQUIRED_VIEWPORTS } from '../catalog.js';
import { teardownVisualFixture } from '../fixtures/screen-fixtures.js';
import { mountGalleryScenario } from '../gallery/mount.js';
import { resolveElementLocator } from './resolve.js';
import { createFrameGrid, requireCheckpoint } from './scenario-locators.js';

afterEach(teardownVisualFixture);

const CONFIRM_DRAFT_SCENARIOS = [
  {
    id: 'workflow-approval-confirm-draft-deleted',
    title: 'Destructive action:',
    options: ['Confirm', 'Confirm with a reason', 'Deny'],
    legend: 'tab/⏎ back to the actions',
  },
  {
    id: 'workflow-approval-confirm-words-stay',
    title: 'Trust and run a configured runner:',
    options: ['Confirm', 'Deny'],
    legend: 'tab back to the actions',
  },
] as const;

describe.each(CONFIRM_DRAFT_SCENARIOS)('$id approval crop', ({ id, title, options, legend }) => {
  it.each(REQUIRED_VIEWPORTS)(
    'shows the prompt, its options and its legend at $cols x $rows',
    async (size) => {
      const scenario = findVisualScenario(id);
      if (scenario === undefined) throw new Error(`Missing confirm-draft scenario ${id}`);
      const checkpoint = requireCheckpoint(scenario);
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
        expect(text).toContain(title);
        for (const option of options) {
          expect(text).toContain(option);
        }
        expect(text).toContain(legend);
        expect(text).not.toContain('queues the typed correction');
        expect(text).not.toContain('queues the correction');
      } finally {
        await handle.unmount();
      }
    },
  );
});
