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

    expect([...result.preCursor, ...result.postCursor].some((segment) => segment.type === 'highlight')).toBe(false);
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

    expect([...result.preCursor, ...result.postCursor].some((segment) => segment.type === 'highlight')).toBe(true);
  });
});
