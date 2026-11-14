import { type VisualLine, indexAtDisplayColumn } from '../../core/editor/grapheme-motions.js';
import type { Segment, SegmentType } from '../../components/input/segments.js';

const clusterSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function clampToLine(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

export function buildEditorRowSegments(
  line: VisualLine,
  opts: { caretCol: number | null; selection: { start: number; end: number } | null },
): Segment[] {
  const text = line.text;
  const caretIndex = opts.caretCol === null ? null : indexAtDisplayColumn(text, opts.caretCol);

  let selStart: number | null = null;
  let selEnd: number | null = null;
  if (opts.selection) {
    const s = clampToLine(opts.selection.start - line.start, text.length);
    const e = clampToLine(opts.selection.end - line.start, text.length);
    if (e > s) {
      selStart = s;
      selEnd = e;
    }
  }

  const out: Segment[] = [];
  let current: Segment | null = null;
  const append = (value: string, type: SegmentType): void => {
    if (current && current.type === type) {
      current.value += value;
      return;
    }
    current = { value, type };
    out.push(current);
  };

  for (const seg of clusterSegmenter.segment(text)) {
    const i = seg.index;
    let type: SegmentType;
    if (selStart !== null && selEnd !== null && i >= selStart && i < selEnd) {
      type = 'highlight';
    }
    if (caretIndex !== null && i === caretIndex) {
      type = 'cursor';
    }
    append(seg.segment, type);
  }

  if (caretIndex !== null && caretIndex >= text.length) {
    append(' ', 'cursor');
  }

  return out;
}
