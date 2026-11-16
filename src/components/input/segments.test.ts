import { describe, expect, it } from 'vitest';
import { buildSegments } from './segments.js';

describe('buildSegments', () => {
  it('keeps a visible caret before an empty focused placeholder', () => {
    const result = buildSegments({
      value: '',
      cursorIndex: 0,
      placeholder: 'Type your answer…',
      focus: true,
      keepPlaceholderWhileFocused: true,
      showCursor: true,
    });

    expect(result.preCursor).toEqual([
      { value: ' ', type: 'cursor' },
      { value: 'Type your answer…', type: 'placeholder' },
    ]);
    expect(result.postCursor).toEqual([]);
  });
});

function renderedText(value: string): string {
  const result = buildSegments({
    value,
    cursorIndex: 0,
    placeholder: '',
    focus: true,
    showCursor: false,
  });
  return [...result.preCursor, ...result.postCursor].map((segment) => segment.value).join('');
}

describe('buildSegments control-byte sanitization', () => {
  it('strips multi-character BEL and C0 bytes while preserving line breaks, expands tabs, and strips CSI sequences', () => {
    expect(renderedText('a\t\x1b[31mb\nc')).toBe('a    b\nc');
  });
});
