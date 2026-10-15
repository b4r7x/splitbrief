import { afterEach, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { listRowLead } from '../../../src/components/list-row.js';
import {
  REVIEW_COMMENT_HINTS,
  REVIEW_DOCUMENT_HINTS,
} from '../../../src/features/workflow/prompt-rows/approval.js';
import { createCropCellGrid } from '../artifacts/crop.js';
import { findVisualScenario } from '../catalog.js';
import { viewport } from '../contracts/geometry.js';
import { teardownVisualFixture } from '../fixtures/screen-fixtures.js';
import { mountGalleryScenario } from '../gallery/mount.js';
import { resolveElementLocator } from './resolve.js';
import { createFrameGrid, requireCheckpoint } from './scenario-locators.js';

afterEach(teardownVisualFixture);

describe.each(['workflow-plan-card', 'workflow-plan-card-commenting'])('%s approval crop', (id) => {
  it.each([60, 80, 120, 160])('includes every action at %s columns', async (cols) => {
    const scenario = findVisualScenario(id);
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
      if (id === 'workflow-plan-card-commenting') {
        expect(text).toContain(`${listRowLead('active')}Request changes (type what to change)`);
        expect(text).not.toContain(`${listRowLead('active')}Approve plan`);
        expect(text).toContain(REVIEW_COMMENT_HINTS);
        expect(text).not.toContain(REVIEW_DOCUMENT_HINTS);
        expect(stripAnsiStyles(frame)).toContain(
          'comment Split the CLI change into a separate task.',
        );
      } else {
        expect(text).toContain(`${listRowLead('active')}Approve plan and start the build`);
        if (cols >= 120) expect(text).toContain(REVIEW_DOCUMENT_HINTS);
      }
    } finally {
      await handle.unmount();
    }
  });
});
