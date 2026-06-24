import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { Divider } from './divider.js';

describe('Divider', () => {
  it('renders a plain rule of the requested width', () => {
    const ui = renderFeature(<Divider width={12} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('────────────');
    expect(frame).not.toContain('  ');

    ui.unmount();
  });

  it('renders a centered label with rule flanks', () => {
    const ui = renderFeature(<Divider width={20} label="3 lines above" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('── 3 lines above ──');
    expect(frame.length).toBeGreaterThan(0);

    ui.unmount();
  });

  it('clamps to zero side padding when label dominates the width', () => {
    const ui = renderFeature(<Divider width={6} label="tiny" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('tiny');
    expect(frame).not.toMatch(/─{3,}/);

    ui.unmount();
  });

  it('fits wide labels to the requested terminal cell width', () => {
    const ui = renderFeature(<Divider width={12} label="ビルド🚨status" />);
    const frame = ui.lastFrame()?.split('\n')[0] ?? '';

    expect(getTerminalCellWidth(frame)).toBeLessThanOrEqual(12);

    ui.unmount();
  });
});
