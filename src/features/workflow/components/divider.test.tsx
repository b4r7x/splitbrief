import { beforeEach, describe, expect, it } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { glyph } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { Divider } from './divider.js';

function withAsciiTier(run: () => void): void {
  const previousTerm = process.env.TERM;
  process.env.TERM = 'dumb';
  try {
    run();
  } finally {
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
  }
}

describe('Divider', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
  });
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

  it('uses ascii divider characters when the glyph tier is ascii', () => {
    withAsciiTier(() => {
      const ui = renderFeature(<Divider width={12} />);
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain(glyph('divider', 'ascii').repeat(12));
      expect(frame).not.toContain('─');
      ui.unmount();
    });
  });
});
