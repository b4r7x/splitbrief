import { stripTerminalControls } from '../../utils/display-text/sanitize.js';

export type SegmentType = 'placeholder' | 'highlight' | 'cursor' | undefined;

export interface Segment {
  value: string;
  type?: SegmentType;
}

// The paint shows a tab as this many spaces; the caret model (text-editing.ts) wraps it the same.
export const TAB_SIZE = 4;

function expandTabs(text: string): string {
  return text.replace(/\t/g, ' '.repeat(TAB_SIZE));
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

export function buildSegments(params: BuildSegmentsParams): SegmentResult {
  const { value, cursorIndex, placeholder, focus, keepPlaceholderWhileFocused, showCursor, mask } =
    params;

  const formatText: FormatText = (text, isPlaceholder = false) => {
    const normalized = normalizeLineEndings(text);
    if (!isPlaceholder && mask) {
      return normalized.replace(/[^\n]/g, mask);
    }
    return stripTerminalControls(expandTabs(normalized), { preserveLineBreaks: true });
  };

  if (!value) {
    if (placeholder && (!focus || keepPlaceholderWhileFocused === true)) {
      return {
        preCursor: [
          ...(focus && showCursor ? [{ value: ' ', type: 'cursor' as const }] : []),
          { value: formatText(placeholder, true), type: 'placeholder' },
        ],
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

  return buildPlainSegments(textBefore, textAfter, showCursor, formatText);
}
