import { stripTerminalControls } from '../../utils/display-text.js';

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
  /** Entry boxes whose placeholder IS the example keep it under the cursor; a chat input does not. */
  keepPlaceholderWhileFocused?: boolean | undefined;
  showCursor: boolean;
  mask?: string | undefined;
  tabSize: number;
  highlight?: { start: number; end: number } | undefined;
}

type FormatText = (text: string, isPlaceholder?: boolean) => string;
type SegmentResult = { preCursor: Segment[]; postCursor: Segment[] };

function buildPlainSegments(
  textBefore: string,
  textAfter: string,
  showCursor: boolean,
  formatText: FormatText,
): SegmentResult {
  return {
    preCursor: [
      { value: formatText(textBefore) },
      { value: showCursor ? ' ' : '', type: 'cursor' },
    ],
    postCursor: [{ value: formatText(textAfter) }],
  };
}

interface HighlightSegmentArgs {
  highlight: { start: number; end: number };
  textBefore: string;
  textAfter: string;
  cursorIndex: number;
  showCursor: boolean;
  valueLength: number;
  formatText: FormatText;
}

function buildSegmentsWithHighlight(args: HighlightSegmentArgs): SegmentResult {
  const { highlight, textBefore, textAfter, cursorIndex, showCursor, valueLength, formatText } =
    args;
  const hasValidHighlight =
    highlight.end > highlight.start && highlight.start >= 0 && highlight.end <= valueLength;

  if (!hasValidHighlight) {
    return buildPlainSegments(textBefore, textAfter, showCursor, formatText);
  }

  const hlStartAfter = Math.max(highlight.start - cursorIndex, 0);
  const hlEndAfter = Math.max(highlight.end - cursorIndex, 0);

  return {
    preCursor: [
      { value: formatText(textBefore.slice(0, highlight.start)) },
      {
        value: formatText(textBefore.slice(highlight.start, Math.min(highlight.end, cursorIndex))),
        type: 'highlight',
      },
      { value: formatText(textBefore.slice(highlight.end)) },
      { value: showCursor ? ' ' : '', type: 'cursor' },
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
  const {
    value,
    cursorIndex,
    placeholder,
    focus,
    keepPlaceholderWhileFocused,
    showCursor,
    mask,
    tabSize,
    highlight,
  } = params;

  const formatText: FormatText = (text, isPlaceholder = false) => {
    const normalized = normalizeLineEndings(text);
    if (!isPlaceholder && mask) {
      return normalized.replace(/[^\n]/g, mask);
    }
    return stripTerminalControls(expandTabs(normalized, tabSize), { preserveLineBreaks: true });
  };

  if (!value) {
    if (placeholder && (!focus || keepPlaceholderWhileFocused === true)) {
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

  if (highlight) {
    return buildSegmentsWithHighlight({
      highlight,
      textBefore,
      textAfter,
      cursorIndex,
      showCursor,
      valueLength: value.length,
      formatText,
    });
  }

  return buildPlainSegments(textBefore, textAfter, showCursor, formatText);
}
