import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { SummaryPhaseTiming } from './phase-timing.js';

describe('SummaryPhaseTiming', () => {
  it('capitalizes phase labels in the rendered breakdown', () => {
    const ui = renderFeature(
      <SummaryPhaseTiming phaseTimings={{ planning: 1200, implementing: 3400 }} labelWidth={16} />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Planning');
    expect(frame).toContain('Implementing');
    expect(frame).not.toContain('planning');
    expect(frame).not.toContain('implementing');

    ui.unmount();
  });

  it('renders nothing when there are no phase timings', () => {
    const ui = renderFeature(<SummaryPhaseTiming phaseTimings={{}} labelWidth={16} />);

    expect(ui.lastFrame()).toBe('');

    ui.unmount();
  });
});
