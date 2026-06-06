import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { SummaryProgress } from './progress.js';

describe('SummaryProgress', () => {
  it('renders local, escalated, and failed counts with the completion ratio', () => {
    const ui = renderFeature(
      <SummaryProgress
        completed={2}
        total={4}
        completedByLocal={1}
        escalatedToPlanner={1}
        failed={1}
        isSmall={false}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('2/4');
    expect(frame).toContain('1 local');
    expect(frame).toContain('1 escalated');
    expect(frame).toContain('1 failed');
    expect(frame).toContain('local = cheap implementer');

    ui.unmount();
  });
});
