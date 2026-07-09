import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import {
  displayColumnOfIndex,
  indexAtDisplayColumn,
  isSoftWrapSeam,
  nextGraphemeIndex,
  prevGraphemeIndex,
  visualPositionOf,
  wordBoundaryBackward,
  wordBoundaryForward,
  wrapVisualLines,
} from './grapheme-motions.js';

const ZWJ_FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
const REGIONAL_FLAG = '\u{1F1F5}\u{1F1F1}';
const SKIN_TONE = '\u{1F44D}\u{1F3FD}';
const COMBINING = 'é';

describe('grapheme motions stay on cluster boundaries', () => {
  it('steps over a ZWJ family cluster as a single unit', () => {
    expect(ZWJ_FAMILY.length).toBe(11);
    expect(nextGraphemeIndex(ZWJ_FAMILY, 0)).toBe(ZWJ_FAMILY.length);
    expect(prevGraphemeIndex(ZWJ_FAMILY, ZWJ_FAMILY.length)).toBe(0);
    expect(nextGraphemeIndex(ZWJ_FAMILY, 3)).toBe(ZWJ_FAMILY.length);
    expect(prevGraphemeIndex(ZWJ_FAMILY, 7)).toBe(0);
  });

  it('steps over a regional-flag cluster as a single unit', () => {
    expect(REGIONAL_FLAG.length).toBe(4);
    expect(nextGraphemeIndex(REGIONAL_FLAG, 0)).toBe(4);
    expect(prevGraphemeIndex(REGIONAL_FLAG, 4)).toBe(0);
  });

  it('steps over a skin-tone cluster as a single unit', () => {
    expect(SKIN_TONE.length).toBe(4);
    expect(nextGraphemeIndex(SKIN_TONE, 0)).toBe(4);
    expect(prevGraphemeIndex(SKIN_TONE, 4)).toBe(0);
  });

  it('steps over a base+combining cluster as a single unit', () => {
    expect(COMBINING.length).toBe(2);
    expect(nextGraphemeIndex(COMBINING, 0)).toBe(2);
    expect(prevGraphemeIndex(COMBINING, 2)).toBe(0);
  });

  it('clamps to the buffer bounds', () => {
    expect(prevGraphemeIndex('abc', 0)).toBe(0);
    expect(prevGraphemeIndex('abc', -5)).toBe(0);
    expect(nextGraphemeIndex('abc', 3)).toBe(3);
    expect(nextGraphemeIndex('abc', 99)).toBe(3);
  });
});

describe('display width', () => {
  it('treats a CJK glyph as two cells', () => {
    expect(getTerminalCellWidth('中')).toBe(2);
    expect(displayColumnOfIndex('中', 1)).toBe(2);
  });

  it('treats ZWJ and combining marks as zero-width joiners inside a cluster', () => {
    expect(getTerminalCellWidth('‍')).toBe(0);
    expect(getTerminalCellWidth('́')).toBe(0);
    expect(getTerminalCellWidth(ZWJ_FAMILY)).toBe(2);
  });
});

describe('wrapVisualLines maps buffer indices', () => {
  it('hard-wraps a logical line and preserves absolute indices across a newline', () => {
    const lines = wrapVisualLines('abcde\nfghij', 3);
    expect(lines).toEqual([
      { start: 0, end: 3, text: 'abc', width: 3 },
      { start: 3, end: 5, text: 'de', width: 2 },
      { start: 6, end: 9, text: 'fgh', width: 3 },
      { start: 9, end: 11, text: 'ij', width: 2 },
    ]);
  });

  it('never splits a wide glyph across the column boundary', () => {
    const lines = wrapVisualLines('中中中', 4);
    expect(lines).toEqual([
      { start: 0, end: 2, text: '中中', width: 4 },
      { start: 2, end: 3, text: '中', width: 2 },
    ]);
  });
});

describe('indexAtDisplayColumn lands at or before the column on a boundary', () => {
  it('never lands inside a wide glyph', () => {
    expect(indexAtDisplayColumn('中中中', 2)).toBe(1);
    expect(indexAtDisplayColumn('中中中', 3)).toBe(1);
    expect(indexAtDisplayColumn('中中中', 4)).toBe(2);
    expect(indexAtDisplayColumn('中中中', 0)).toBe(0);
  });
});

describe('visualPositionOf honors affinity at soft-wrap seams', () => {
  it('resolves upstream to the upper row end at a seam (today’s default)', () => {
    const lines = wrapVisualLines('abcdefghij', 4);
    expect(visualPositionOf(lines, 4, 'upstream')).toEqual({ row: 0, col: 4 });
  });

  it('resolves downstream to the lower row col 0 at the same seam', () => {
    const lines = wrapVisualLines('abcdefghij', 4);
    expect(visualPositionOf(lines, 4, 'downstream')).toEqual({ row: 1, col: 0 });
  });

  it('is affinity-independent for a non-seam cursor', () => {
    const lines = wrapVisualLines('abcdefghij', 4);
    expect(visualPositionOf(lines, 2, 'upstream')).toEqual({ row: 0, col: 2 });
    expect(visualPositionOf(lines, 2, 'downstream')).toEqual({ row: 0, col: 2 });
  });

  it('does not treat a hard newline as a soft-wrap seam', () => {
    const lines = wrapVisualLines('aa\nbb', 80);
    expect(isSoftWrapSeam(lines, 2)).toBe(false);
  });

  it('falls through to the last row width for a downstream cursor at the buffer end', () => {
    const lines = wrapVisualLines('abcdefghij', 4);
    expect(visualPositionOf(lines, 10, 'downstream')).toEqual({ row: 2, col: 2 });
  });

  it('resolves a wide/CJK seam to lower-row col 0 downstream and upper-row display width upstream', () => {
    const lines = wrapVisualLines('abcd中efg', 5);
    expect(isSoftWrapSeam(lines, 4)).toBe(true);
    expect(visualPositionOf(lines, 4, 'downstream')).toEqual({ row: 1, col: 0 });
    expect(visualPositionOf(lines, 4, 'upstream')).toEqual({ row: 0, col: 4 });
  });
});

describe('word boundaries stop at whitespace, not at newlines', () => {
  const value = 'foo bar\nbaz';

  it('walks forward across a word and stops before the space', () => {
    expect(wordBoundaryForward(value, 0)).toBe(3);
    expect(wordBoundaryForward(value, 3)).toBe(7);
  });

  it('walks backward across a word and stops after the space', () => {
    expect(wordBoundaryBackward(value, 7)).toBe(4);
  });

  it('does not cross a newline', () => {
    expect(wordBoundaryForward(value, 8)).toBe(11);
    expect(wordBoundaryBackward(value, 8)).toBe(8);
  });
});
