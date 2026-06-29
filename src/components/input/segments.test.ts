import { describe, expect, it } from 'vitest';
import { buildSegments } from './segments.js';

describe('buildSegments', () => {
  it('does not synthesize a current-line highlight when no highlight is requested', () => {
    const result = buildSegments({
      value: 'first line wraps visually into another row',
      cursorIndex: 'first line'.length,
      placeholder: '',
      focus: true,
      showCursor: true,
      tabSize: 4,
    });

    expect(
      [...result.preCursor, ...result.postCursor].some((segment) => segment.type === 'highlight'),
    ).toBe(false);
  });

  it('keeps explicit highlight ranges for pasted text', () => {
    const result = buildSegments({
      value: 'hello pasted text',
      cursorIndex: 'hello pasted'.length,
      placeholder: '',
      focus: true,
      showCursor: true,
      tabSize: 4,
      highlight: { start: 'hello '.length, end: 'hello pasted'.length },
    });

    expect(
      [...result.preCursor, ...result.postCursor].some((segment) => segment.type === 'highlight'),
    ).toBe(true);
  });
});

function renderedText(value: string, tabSize = 4): string {
  const result = buildSegments({
    value,
    cursorIndex: 0,
    placeholder: '',
    focus: true,
    showCursor: false,
    tabSize,
  });
  return [...result.preCursor, ...result.postCursor].map((segment) => segment.value).join('');
}

describe('buildSegments control-byte sanitization', () => {
  it('strips multi-character BEL and C0 bytes while preserving line breaks', () => {
    expect(renderedText('a\x07b\nc\x01d')).toBe('ab\ncd');
  });

  it('strips CSI/OSC escape sequences from the rendered text', () => {
    expect(renderedText('\x1b[31mred\x1b[0m')).toBe('red');
    expect(renderedText('before\x1b]0;title\x07after')).toBe('beforeafter');
  });

  it('expands and preserves tabs as spaces rather than dropping them', () => {
    expect(renderedText('a\tb', 2)).toBe('a  b');
  });
});
