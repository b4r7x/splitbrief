import { beforeEach, describe, expect, it } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { glyph } from '../lib/glyphs.js';
import { FilterInput } from './filter-input.js';

function frameOf(element: Parameters<typeof renderFeature>[0]): string {
  const ui = renderFeature(element);
  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return frame;
}

describe('FilterInput', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
  });

  it('renders the accent prompt glyph', () => {
    const frame = frameOf(<FilterInput filter="" placeholder="filter sessions" />);
    expect(frame).toContain(glyph('prompt'));
  });

  it('shows the dim placeholder while the filter is empty', () => {
    const frame = frameOf(<FilterInput filter="" placeholder="filter sessions" />);
    expect(frame).toContain('filter sessions');
  });

  it('shows the typed value and drops the placeholder once the filter is non-empty', () => {
    const frame = frameOf(<FilterInput filter="auth flow" placeholder="filter sessions" />);
    expect(frame).toContain('auth flow');
    expect(frame).not.toContain('filter sessions');
  });

  it('renders one consistent single-line style across empty and typed states', () => {
    const empty = frameOf(<FilterInput filter="" placeholder="filter sessions" />);
    const typed = frameOf(<FilterInput filter="auth" placeholder="filter sessions" />);

    for (const frame of [empty, typed]) {
      expect(frame.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(1);
      expect(frame.trimStart().startsWith(glyph('prompt'))).toBe(true);
    }
  });
});
