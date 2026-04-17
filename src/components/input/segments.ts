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

type FormatText = (text: string, isPlaceholder?: boolean) => string;
type SegmentResult = { preCursor: Segment[]; postCursor: Segment[] };

function buildSegmentsWithHighlight(
  highlight: { start: number; end: number },
  textBefore: string,
  textAfter: string,
  cursorIndex: number,
  showCursor: boolean,
  focus: boolean,
  valueLength: number,
  formatText: FormatText,
): SegmentResult {
  const hasValidHighlight =
    highlight.end > highlight.start &&
    highlight.start >= 0 &&
    highlight.end <= valueLength;

  if (!hasValidHighlight) {
    const formattedBefore = formatText(textBefore);
    const formattedAfter = formatText(textAfter);
    const lineStart = formattedBefore.lastIndexOf('\n') + 1;
    const rawEnd = formattedAfter.indexOf('\n');
    const lineEnd = rawEnd === -1 ? formattedAfter.length : rawEnd;
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

  const hlStartAfter = Math.max(highlight.start - cursorIndex, 0);
  const hlEndAfter = Math.max(highlight.end - cursorIndex, 0);

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
      { value: formatText(textAfter.slice(0, hlStartAfter)) },
      {
        value: formatText(textAfter.slice(hlStartAfter, hlEndAfter)),
        type: 'highlight',
      },
      { value: formatText(textAfter.slice(hlEndAfter)) },
    ],
  };
}

export function buildSegments(params: BuildSegmentsParams): SegmentResult {
  const { value, cursorIndex, placeholder, focus, showCursor, mask, tabSize, highlight } = params;

  const formatText: FormatText = (text, isPlaceholder = false) => {
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

  return buildSegmentsWithHighlight(
    highlight ?? { start: 0, end: 0 },
    textBefore,
    textAfter,
    cursorIndex,
    showCursor,
    focus,
    value.length,
    formatText,
  );
}
