import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { spinnerFrames } from '../../../lib/glyphs.js';
import { Spinner } from './spinner.js';

describe('Spinner', () => {
  it('renders the label alongside the tier-resolved spinner frame', () => {
    const ui = renderFeature(<Spinner label="checking readiness" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('checking readiness');
    // The portable default is the line spinner; the first frame is index 0.
    const frames = spinnerFrames();
    expect(frame).toContain(frames[0]);

    ui.unmount();
  });
});
