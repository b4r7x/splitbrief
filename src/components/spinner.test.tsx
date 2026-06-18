import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { Spinner } from './spinner.js';

describe('Spinner', () => {
  it('renders static elapsed time without still-waiting copy', () => {
    const ui = renderFeature(<Spinner label="cancelled" elapsedMs={65_000} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('cancelled');
    expect(frame).toContain('65s');
    expect(frame).not.toContain('(still waiting...)');

    ui.unmount();
  });
});
