import { describe, expect, it } from 'vitest';
import { repairMarkdownTailChunk } from './repair.js';

describe('repairMarkdownTailChunk', () => {
  const source = 'A **bold** ~~strike~~ and `code` end';

  it.each([
    [5, 'A **b**'],
    [6, 'A **bo**'],
    [9, 'A **bold**'],
    [12, 'A **bold** ~'],
    [13, 'A **bold** ~~~~'],
    [14, 'A **bold** ~~s~~'],
    [20, 'A **bold** ~~strike~~'],
    [28, 'A **bold** ~~strike~~ and `c`'],
    [31, 'A **bold** ~~strike~~ and `code`'],
    [36, 'A **bold** ~~strike~~ and `code` end'],
  ])('closes unterminated constructs when split at offset %i', (offset, expected) => {
    expect(repairMarkdownTailChunk(source.slice(0, offset))).toBe(expected);
  });

  it('is idempotent on balanced text', () => {
    const balanced = [
      '',
      'plain text with no markup',
      'has **bold**, *italic*, ~~strike~~, and `code`',
      '***a** b*',
      '***a***',
      'a **b `x` c** d',
      'code hides delimiters: `** ~~ *` outside **fine**',
      'keep **5 * 3** math intact',
      'first line\n* item text',
      'O(n*m)',
      '3*4',
      'a~~b',
      'src/**/*.ts',
    ];
    for (const text of balanced) {
      expect(repairMarkdownTailChunk(text)).toBe(text);
    }
  });

  it('closes nested emphasis openers in LIFO order', () => {
    expect(repairMarkdownTailChunk('***a')).toBe('***a***');
    expect(repairMarkdownTailChunk('***a** b')).toBe('***a** b*');
    expect(repairMarkdownTailChunk('*i **b')).toBe('*i **b***');
    expect(repairMarkdownTailChunk('***a** b*')).toBe('***a** b*');
  });

  it('completes a closing delimiter split mid-delimiter', () => {
    expect(repairMarkdownTailChunk('**a*')).toBe('**a**');
    expect(repairMarkdownTailChunk('~~a~')).toBe('~~a~~');
    expect(repairMarkdownTailChunk('***a*')).toBe('***a***');
    expect(repairMarkdownTailChunk('***a**')).toBe('***a***');
  });

  it('ignores delimiters inside inline code spans', () => {
    expect(repairMarkdownTailChunk('`a ** b')).toBe('`a ** b`');
    expect(repairMarkdownTailChunk('x `** ~~` y **b')).toBe('x `** ~~` y **b**');
  });

  it('treats space-flanked and lone delimiters as literal text', () => {
    expect(repairMarkdownTailChunk('multiply 3 * 4 and 5 ** 2')).toBe('multiply 3 * 4 and 5 ** 2');
    expect(repairMarkdownTailChunk('save ~5 files')).toBe('save ~5 files');
    expect(repairMarkdownTailChunk('trailing ~')).toBe('trailing ~');
  });
});
