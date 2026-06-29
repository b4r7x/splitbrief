import { afterEach, describe, expect, it } from 'vitest';
import { glyph, resolveGlyphTier } from './glyphs.js';

describe('glyph tier', () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('resolves ascii on dumb terminals', () => {
    expect(resolveGlyphTier({ TERM: 'dumb' })).toBe('ascii');
  });

  it('maps cursors, status marks, dividers, and checks to ascii markers', () => {
    expect(glyph('liveBar', 'ascii')).toBe('|');
    expect(glyph('cursor', 'ascii')).toBe('>');
    expect(glyph('editCursor', 'ascii')).toBe('|');
    expect(glyph('prompt', 'ascii')).toBe('>');
    expect(glyph('statusPending', 'ascii')).toBe('o');
    expect(glyph('statusCancelled', 'ascii')).toBe('x');
    expect(glyph('check', 'ascii')).toBe('+');
    expect(glyph('divider', 'ascii')).toBe('-');
  });
});
