import { afterEach, describe, expect, it } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import {
  BRAILLE_SPINNER_FRAMES,
  LINE_SPINNER_FRAMES,
  glyph,
  prefersBrailleSpinner,
  resolveGlyphTier,
  spinnerFrames,
} from './glyphs.js';

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

  it('maps the prompt marker through both tiers', () => {
    expect(glyph('promptMarker', 'unicode')).toBe('❯');
    expect(glyph('promptMarker', 'ascii')).toBe('>');
  });
});

describe('spinner frames', () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('prefers braille on every unicode-tier host, without a terminal-program allowlist', () => {
    forceUnicodeGlyphs();
    const unicodeEnv = { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' };
    expect(resolveGlyphTier(unicodeEnv)).toBe('unicode');
    expect(prefersBrailleSpinner(unicodeEnv)).toBe(true);
    expect(spinnerFrames(unicodeEnv)).toBe(BRAILLE_SPINNER_FRAMES);
  });

  it('falls back to the line spinner on the ascii tier', () => {
    expect(prefersBrailleSpinner({ TERM: 'dumb' })).toBe(false);
    expect(spinnerFrames({ TERM: 'dumb' })).toBe(LINE_SPINNER_FRAMES);
  });
});
