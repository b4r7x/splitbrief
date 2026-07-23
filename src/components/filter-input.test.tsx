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

  it('renders a single-line prompt with placeholder or typed value', () => {
    const empty = frameOf(<FilterInput filter="" placeholder="filter sessions" />);
    const typed = frameOf(<FilterInput filter="auth flow" placeholder="filter sessions" />);

    expect(empty).toContain(glyph('prompt'));
    expect(empty).toContain('filter sessions');
    expect(typed).toContain('auth flow');
    expect(typed).not.toContain('filter sessions');

    for (const frame of [empty, typed]) {
      expect(frame.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(1);
      expect(frame.trimStart().startsWith(glyph('prompt'))).toBe(true);
    }
  });
});
