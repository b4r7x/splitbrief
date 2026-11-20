import { describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { acrossNoticeEdges } from '#testing/helpers/notice-text.js';
import { configStore } from '../../../src/stores/project/config.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { findVisualScenario } from '../catalog.js';
import { viewport, type Viewport } from '../contracts/geometry.js';
import { mountGalleryScenario } from './mount.js';

const REASON = 'Read-only while REVIEW is None: no review runs.';

const VIEWPORTS: readonly Viewport[] = [
  viewport({ cols: 60, rows: 18 }),
  viewport({ cols: 80, rows: 24 }),
  viewport({ cols: 120, rows: 40 }),
];

describe('a gallery capture of a settings row REVIEW None holds', () => {
  describe.each(VIEWPORTS)('at $cols x $rows', (renderViewport: Viewport) => {
    it('captures locked Enter when the Settings frame stays unchanged', async () => {
      const scenario = findVisualScenario('overlay-settings-review-none-locked-enter');
      const checkpoint = scenario?.checkpoints[0];
      if (scenario === undefined || checkpoint === undefined) {
        throw new Error('Missing overlay-settings-review-none-locked-enter scenario');
      }

      const capture = await mountGalleryScenario({
        scenario,
        checkpoint,
        viewport: renderViewport,
      });
      try {
        const frame = stripAnsiStyles(await capture.waitForCheckpoint());
        // A notice may wrap the reason, so its words are read across the panel and notice edges.
        expect(acrossNoticeEdges(frame).split(REASON)).toHaveLength(2);
        expect(configStore.get().config?.reviewer).toBe('none');
        expect(configStore.get().config?.validation.endChecks).toBeUndefined();
        expect(feedbackStore.get()).toEqual(
          renderViewport.rows >= 19
            ? { message: null, severity: 'info' }
            : { message: REASON, severity: 'error' },
        );
      } finally {
        await capture.unmount();
      }
    });
  });
});
