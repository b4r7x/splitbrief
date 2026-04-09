export type SegmentType = 'placeholder' | 'highlight' | 'cursor' | undefined;

export interface Segment {
  value: string;
  type?: SegmentType;
}

function expandTabs(text: string, tabSize: number): string {
  return text.replace(/\t/g, ' '.repeat(tabSize));
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export interface BuildSegmentsParams {
  value: string;
  cursorIndex: number;
  placeholder: string;
  focus: boolean;
  showCursor: boolean;
  mask?: string | undefined;
  tabSize: number;
  highlight?: { start: number; end: number } | undefined;
}

export function buildSegments(params: BuildSegmentsParams): { preCursor: Segment[]; postCursor: Segment[] } {
  const { value, cursorIndex, placeholder, focus, showCursor, mask, tabSize, highlight } = params;

  const formatText = (text: string, isPlaceholder = false) => {
    const normalized = normalizeLineEndings(text);
    if (!isPlaceholder && mask) {
      return normalized.replace(/[^\n]/g, mask);
    }
    return expandTabs(normalized, tabSize);
  };

  if (!value) {
    if (placeholder && !focus) {
      return {
        preCursor: [{ value: formatText(placeholder, true), type: 'placeholder' }],
        postCursor: [],
      };
    }
    return {
      preCursor: [{ value: ' ', type: 'cursor' }],
      postCursor: [],
    };
  }

  const textBefore = value.slice(0, cursorIndex);
  const textAfter = value.slice(cursorIndex);

  if (!focus) {
    return {
      preCursor: [{ value: formatText(value) }],
      postCursor: [],
    };
  }

  const hasValidHighlight =
    highlight &&
    highlight.end > highlight.start &&
    highlight.start >= 0 &&
    highlight.end <= value.length;

  if (!hasValidHighlight) {
    const formattedBefore = formatText(textBefore);
    const formattedAfter = formatText(textAfter);
    const lineStart = formattedBefore.lastIndexOf('\n') + 1;
    const lineEnd = formattedAfter.indexOf('\n');
    return {
      preCursor: [
        { value: formattedBefore.slice(0, lineStart) },
        { value: formattedBefore.slice(lineStart), type: 'highlight' },
        { value: showCursor && focus ? ' ' : '', type: 'cursor' },
      ],
      postCursor: [
        { value: formattedAfter.slice(0, lineEnd), type: 'highlight' },
        { value: formattedAfter.slice(lineEnd) },
      ],
    };
  }

  return {
    preCursor: [
      { value: formatText(textBefore.slice(0, highlight.start)) },
      {
        value: formatText(
          textBefore.slice(highlight.start, Math.min(highlight.end, cursorIndex)),
        ),
        type: 'highlight',
      },
      { value: formatText(textBefore.slice(highlight.end)) },
      { value: ' ', type: 'cursor' },
    ],
    postCursor: [
      {
        value: formatText(
          textAfter.slice(0, Math.max(highlight.start - cursorIndex, 0)),
        ),
      },
      {
        value: formatText(
          textAfter.slice(
            Math.max(highlight.start - cursorIndex, 0),
            Math.max(highlight.end - cursorIndex, 0),
          ),
        ),
        type: 'highlight',
      },
      {
        value: formatText(
          textAfter.slice(Math.max(highlight.end - cursorIndex, 0)),
        ),
      },
    ],
  };
}
