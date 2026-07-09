import { describe, expect, it } from 'vitest';
import { wrapVisualLines } from '../../core/editor/grapheme-motions.js';
import { buildEditorRowSegments } from './editor-line-segments.js';

// biome-ignore lint/complexity/useRegexLiterals: a /\x1b\[/ literal is rejected by noControlCharactersInRegex; the constructor is the only lint-clean way to match the CSI escape
const csiSequence = new RegExp('\\x1b\\[', 'g');

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

  it('renders zero absolute escape sequences (no CUP / DECSLRM / CSI)', () => {
    const line = wrapVisualLines('the quick brown fox', 40)[0];
    if (line === undefined) throw new Error('expected a visual line');

    const segments = buildEditorRowSegments(line, {
      caretCol: 4,
      selection: { start: 4, end: 9 },
    });

    const rendered = segments.map((s) => s.value).join('');
    expect(rendered.match(csiSequence)).toBeNull();
  });

  it('places a trailing caret cell when the caret sits past the row text', () => {
    const line = wrapVisualLines('end', 40)[0];
    if (line === undefined) throw new Error('expected a visual line');

    const segments = buildEditorRowSegments(line, { caretCol: 3, selection: null });

    const last = segments.at(-1);
    expect(last?.type).toBe('cursor');
    expect(last?.value).toBe(' ');
    expect(segments.map((s) => s.value).join('')).not.toMatch(csiSequence);
  });
});
