import { stripTerminalControls, type TerminalDisplayTextOptions } from './sanitize.js';

const EMOJI_VARIATION_SELECTOR = '\ufe0f';
const KEYCAP_SEQUENCE_PATTERN = /^[#*0-9]\ufe0f?\u20e3$/u;
const DEFAULT_EMOJI_PRESENTATION_PATTERN = /\p{Emoji_Presentation}/u;
const EMOJI_VARIATION_BASE_PATTERN = /\p{Extended_Pictographic}/u;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Printable ASCII carries no control sequences to strip and no combining, wide, or
// emoji code points, so each character is exactly one grapheme of one cell.
const PRINTABLE_ASCII_PATTERN = /^[ -~]*$/;

export function getTerminalCellWidth(text: string): number {
  if (PRINTABLE_ASCII_PATTERN.test(text)) return text.length;

  let width = 0;
  for (const grapheme of graphemes(stripTerminalControls(text))) {
    width += getGraphemeWidth(grapheme);
  }
  return width;
}

export function* iterateTerminalGraphemes(
  text: string,
  opts: TerminalDisplayTextOptions = {},
): IterableIterator<string> {
  for (const part of graphemeSegmenter.segment(stripTerminalControls(text, opts))) {
    yield part.segment;
  }
}

export function splitTerminalGraphemes(
  text: string,
  opts: TerminalDisplayTextOptions = {},
): string[] {
  if (PRINTABLE_ASCII_PATTERN.test(text)) return text.split('');
  return Array.from(iterateTerminalGraphemes(text, opts));
}

export function wrapTerminalGraphemes(input: {
  graphemes: Iterable<string>;
  maxWidth: number;
  initialWidth?: number;
  flush: () => number | undefined;
  append: (grapheme: string) => void;
}): void {
  const maxWidth = Math.max(1, input.maxWidth);
  let lineWidth = Math.max(0, input.initialWidth ?? 0);

  for (const grapheme of input.graphemes) {
    const graphemeWidth = getTerminalCellWidth(grapheme);
    if (lineWidth > 0 && lineWidth + graphemeWidth > maxWidth) {
      const flushedWidth = input.flush();
      lineWidth = typeof flushedWidth === 'number' ? Math.max(0, flushedWidth) : 0;
    }
    input.append(grapheme);
    lineWidth += graphemeWidth;
  }
}

/**
 * The grapheme clusters of `text` with every character kept: unlike `splitTerminalGraphemes`,
 * it strips no control.
 */
export function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

export function getGraphemeWidth(grapheme: string): number {
  if (hasEmojiPresentation(grapheme)) return 2;

  let width = 0;
  for (const char of grapheme) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || isZeroWidthCodePoint(codePoint)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function hasEmojiPresentation(grapheme: string): boolean {
  return (
    DEFAULT_EMOJI_PRESENTATION_PATTERN.test(grapheme) ||
    KEYCAP_SEQUENCE_PATTERN.test(grapheme) ||
    (grapheme.includes(EMOJI_VARIATION_SELECTOR) && EMOJI_VARIATION_BASE_PATTERN.test(grapheme))
  );
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x200d ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    codePoint === 0x0e31 ||
    (codePoint >= 0x0e34 && codePoint <= 0x0e3a) ||
    (codePoint >= 0x0e47 && codePoint <= 0x0e4e) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

export function segmentsForRowText<Segment extends { text: string }>(
  segments: readonly Segment[],
  text: string,
  start = 0,
): Segment[] {
  const result: Segment[] = [];
  const end = start + text.length;
  let offset = 0;
  for (const segment of segments) {
    const segmentEnd = offset + segment.text.length;
    const from = Math.max(start, offset);
    const to = Math.min(end, segmentEnd);
    if (to > from) result.push({ ...segment, text: text.slice(from - start, to - start) });
    offset = segmentEnd;
    if (offset >= end) break;
  }
  return result;
}
