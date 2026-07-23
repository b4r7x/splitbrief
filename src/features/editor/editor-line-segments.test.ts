import { describe, expect, it } from 'vitest';
import { wrapVisualLines } from '../../core/editor/grapheme-motions.js';
import { buildEditorRowSegments } from './editor-line-segments.js';

describe('buildEditorRowSegments', () => {
  it('emits a caret cell and contiguous highlight cells for a wrapped row', () => {
    const line = wrapVisualLines('hello world', 40)[0];
    if (line === undefined) throw new Error('expected a visual line');

    const segments = buildEditorRowSegments(line, {
      caretCol: 3,
      selection: { start: 6, end: 9 },
    });

    expect(segments.some((s) => s.type === 'cursor')).toBe(true);
    const highlight = segments.filter((s) => s.type === 'highlight');
    expect(highlight).toHaveLength(1);
    expect(highlight[0]?.value).toBe('wor');
    expect(segments.map((s) => s.value).join('')).toBe('hello world');
  });

  it('places a trailing caret cell when the caret sits past the row text', () => {
    const line = wrapVisualLines('end', 40)[0];
    if (line === undefined) throw new Error('expected a visual line');

    const segments = buildEditorRowSegments(line, { caretCol: 3, selection: null });

    const last = segments.at(-1);
    expect(last?.type).toBe('cursor');
    expect(last?.value).toBe(' ');
  });
});
