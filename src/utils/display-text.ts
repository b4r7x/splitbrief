import { redactSecrets } from './redact.js';

export const ELLIPSIS = '\u2026';
export const DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS = 4000;
const ESC = '\\u001b';
const BEL = '\\u0007';
const STRING_TERMINATOR = '\\u009c';
const CSI = '\\u009b';
const OSC = '\\u009d';
const C0_CONTROL_RANGE_EXCEPT_WHITESPACE = '\\u0000-\\u0008\\u000e-\\u001f';
const C1_CONTROL_RANGE = '\\u007f-\\u009f';
const EMOJI_VARIATION_SELECTOR = '\ufe0f';

const OSC_SEQUENCE_PATTERN = new RegExp(
  `(?:${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\|$)|${OSC}[\\s\\S]*?(?:${BEL}|${STRING_TERMINATOR}|$))`,
  'g',
);
const STRING_CONTROL_SEQUENCE_PATTERN = new RegExp(
  `(?:${ESC}[\\u0050\\u0058\\u005e\\u005f][\\s\\S]*?(?:${ESC}\\\\|$)|[\\u0090\\u0098\\u009e\\u009f][\\s\\S]*?(?:${STRING_TERMINATOR}|$))`,
  'g',
);
const CSI_SEQUENCE_PATTERN = new RegExp(
  `(?:${ESC}\\[[0-?]*[ -/]*[@-~]|${CSI}[0-?]*[ -/]*[@-~])`,
  'g',
);
const ESCAPE_SEQUENCE_PATTERN = new RegExp(`${ESC}(?:[ -/]*[@-~]|[@-Z\\\\-_])`, 'g');
const CONTROL_CHARACTER_EXCEPT_WHITESPACE_PATTERN = new RegExp(
  `[${C0_CONTROL_RANGE_EXCEPT_WHITESPACE}${C1_CONTROL_RANGE}]`,
  'g',
);
const WHITESPACE_CONTROL_RUN_PATTERN = /[\t\n\v\f\r]+/g;
const WHITESPACE_CONTROL_EXCEPT_LINE_BREAK_PATTERN = /[\t\v\f]/g;
const KEYCAP_SEQUENCE_PATTERN = /^[#*0-9]\ufe0f?\u20e3$/u;
const DEFAULT_EMOJI_PRESENTATION_PATTERN = /\p{Emoji_Presentation}/u;
const EMOJI_VARIATION_BASE_PATTERN = /\p{Extended_Pictographic}/u;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Printable ASCII carries no control sequences to strip and no combining, wide, or
// emoji code points, so each character is exactly one grapheme of one cell.
const PRINTABLE_ASCII_PATTERN = /^[ -~]*$/;

export interface TerminalDiagnosticTextOptions {
  maxChars?: number | undefined;
  preserveLineBreaks?: boolean | undefined;
}

export interface TerminalDisplayTextOptions {
  preserveLineBreaks?: boolean | undefined;
}

/**
 * Escape sequences and controls removed. A line break or a tab becomes a space, never nothing, so
 * the words on each side stay apart: on one row each run of them is one space; with
 * `preserveLineBreaks` a line break stays (`\r\n` and `\r` as `\n`) and each tab is one space.
 */
export function stripTerminalControls(text: string, opts: TerminalDisplayTextOptions = {}): string {
  const stripped = text
    .replace(OSC_SEQUENCE_PATTERN, '')
    .replace(STRING_CONTROL_SEQUENCE_PATTERN, '')
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(ESCAPE_SEQUENCE_PATTERN, '')
    .replace(CONTROL_CHARACTER_EXCEPT_WHITESPACE_PATTERN, '');

  return opts.preserveLineBreaks
    ? stripped.replace(/\r\n?/g, '\n').replace(WHITESPACE_CONTROL_EXCEPT_LINE_BREAK_PATTERN, ' ')
    : stripped.replace(WHITESPACE_CONTROL_RUN_PATTERN, ' ');
}

export function sanitizeTerminalDisplayText(
  text: string,
  opts: TerminalDisplayTextOptions = {},
): string {
  return redactSecrets(stripTerminalControls(text, opts));
}

/** Text on one row: controls stripped, secrets redacted, spaces made single and trimmed. */
export function oneLineDisplayText(text: string): string {
  return sanitizeTerminalDisplayText(text).replace(/\s+/g, ' ').trim();
}

/**
 * A one-line label with its invisible format characters (`\p{Cf}`) removed and its spaces
 * single. `stripTerminalControls` keeps them, because a ZWJ binds an emoji sequence in prose.
 */
export function normalizeDisplayLabel(text: string): string {
  return stripTerminalControls(text)
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeTerminalDiagnosticText(
  text: string,
  opts: TerminalDiagnosticTextOptions = {},
): string {
  return truncateDiagnosticText(
    sanitizeTerminalDisplayText(text, { preserveLineBreaks: opts.preserveLineBreaks }),
    opts.maxChars ?? DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS,
  );
}

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

export function truncateTerminalDisplayText(text: string, maxCells: number): string {
  if (maxCells <= 0) return '';

  const clean = stripTerminalControls(text);
  if (getTerminalCellWidth(clean) <= maxCells) return clean;

  const ellipsisWidth = getTerminalCellWidth(ELLIPSIS);
  if (maxCells <= ellipsisWidth) return ELLIPSIS;

  const contentWidth = maxCells - ellipsisWidth;
  let width = 0;
  let result = '';

  for (const grapheme of graphemes(clean)) {
    const graphemeWidth = getGraphemeWidth(grapheme);
    if (width + graphemeWidth > contentWidth) break;
    result += grapheme;
    width += graphemeWidth;
  }

  return `${result}${ELLIPSIS}`;
}

export function truncateTerminalDisplayTextStart(text: string, maxCells: number): string {
  if (maxCells <= 0) return '';

  const clean = stripTerminalControls(text);
  if (getTerminalCellWidth(clean) <= maxCells) return clean;

  const ellipsisWidth = getTerminalCellWidth(ELLIPSIS);
  if (maxCells <= ellipsisWidth) return takeTrailingCells(clean, maxCells) || ELLIPSIS;

  const tail = takeTrailingCells(clean, maxCells - ellipsisWidth);
  return tail.length > 0 ? `${ELLIPSIS}${tail}` : ELLIPSIS;
}

export function truncateTerminalDisplayTextMiddle(text: string, maxCells: number): string {
  if (maxCells <= 0) return '';

  const clean = stripTerminalControls(text);
  if (getTerminalCellWidth(clean) <= maxCells) return clean;

  const ellipsisWidth = getTerminalCellWidth(ELLIPSIS);
  if (maxCells <= ellipsisWidth) return ELLIPSIS;

  const contentWidth = maxCells - ellipsisWidth;
  const headWidth = Math.floor(contentWidth / 2);
  const tailWidth = Math.ceil(contentWidth / 2);
  const head = takeLeadingCells(clean, headWidth);
  const tail = takeTrailingCells(clean, tailWidth);

  return `${head}${ELLIPSIS}${tail}`;
}

export function truncateTerminalDisplayTextMiddleAtWords(text: string, maxCells: number): string {
  if (maxCells <= 0) return '';

  const clean = stripTerminalControls(text);
  if (getTerminalCellWidth(clean) <= maxCells) return clean;

  const separator = ` ${ELLIPSIS} `;
  const contentWidth = maxCells - getTerminalCellWidth(separator);
  if (contentWidth <= 0) return truncateTerminalDisplayTextMiddle(clean, maxCells);

  const tokens = Array.from(clean.matchAll(/\S+/gu));
  let headIndex = 0;
  let tailIndex = tokens.length - 1;
  let head = '';
  let tail = '';
  let headWidth = 0;
  let tailWidth = 0;

  while (headIndex <= tailIndex) {
    const headToken = tokens[headIndex];
    const tailToken = tokens[tailIndex];
    if (headToken === undefined || tailToken === undefined) break;

    const nextHead = clean.slice(0, headToken.index + headToken[0].length);
    const nextTail = clean.slice(tailToken.index);
    const nextHeadWidth = getTerminalCellWidth(nextHead);
    const nextTailWidth = getTerminalCellWidth(nextTail);
    const headFits = nextHeadWidth + tailWidth <= contentWidth;
    const tailFits = headWidth + nextTailWidth <= contentWidth;

    if ((headWidth <= tailWidth || !tailFits) && headFits) {
      head = nextHead;
      headWidth = nextHeadWidth;
      headIndex += 1;
    } else if (tailFits) {
      tail = nextTail;
      tailWidth = nextTailWidth;
      tailIndex -= 1;
    } else {
      break;
    }
  }

  if (head.length === 0 || tail.length === 0) {
    return truncateTerminalDisplayTextMiddle(clean, maxCells);
  }
  return `${head}${separator}${tail}`;
}

export function elidePathLabel(label: string, width: number): string {
  if (getTerminalCellWidth(label) <= width) return label;
  const segments = label.split('/');
  for (let start = 1; start < segments.length; start++) {
    const candidate = `${ELLIPSIS}/${segments.slice(start).join('/')}`;
    if (getTerminalCellWidth(candidate) <= width) return candidate;
  }
  return label;
}

export function elidePathMiddle(path: string, width: number): string {
  if (getTerminalCellWidth(path) <= width) return path;
  const separator = path.indexOf('/');
  if (separator >= 0) {
    const prefix = path.slice(0, separator + 1);
    const middle = `${prefix}${elidePathLabel(path.slice(separator + 1), width - getTerminalCellWidth(prefix))}`;
    if (getTerminalCellWidth(middle) <= width) return middle;
    const tail = elidePathLabel(path, width);
    if (getTerminalCellWidth(tail) <= width) return tail;
  }
  const filename = path.slice(path.lastIndexOf('/') + 1);
  return truncateTerminalDisplayTextMiddle(filename, width);
}

export function padTerminalDisplayTextEnd(text: string, width: number): string {
  const clean = stripTerminalControls(text);
  return `${clean}${' '.repeat(Math.max(0, width - getTerminalCellWidth(clean)))}`;
}

/**
 * The grapheme clusters of `text` with every character kept: unlike `splitTerminalGraphemes`,
 * it strips no control.
 */
export function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

function truncateDiagnosticText(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  if (maxChars <= ELLIPSIS.length) return ELLIPSIS.slice(0, maxChars);
  return `${text.slice(0, maxChars - ELLIPSIS.length)}${ELLIPSIS}`;
}

function takeTrailingCells(text: string, maxCells: number): string {
  let width = 0;
  const result: string[] = [];
  const parts = graphemes(text);

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const grapheme = parts[index];
    if (grapheme === undefined) continue;
    const graphemeWidth = getGraphemeWidth(grapheme);
    if (width + graphemeWidth > maxCells) break;
    result.unshift(grapheme);
    width += graphemeWidth;
  }

  return result.join('');
}

function takeLeadingCells(text: string, maxCells: number): string {
  let width = 0;
  let result = '';

  for (const grapheme of graphemes(text)) {
    const graphemeWidth = getGraphemeWidth(grapheme);
    if (width + graphemeWidth > maxCells) break;
    result += grapheme;
    width += graphemeWidth;
  }

  return result;
}

function getGraphemeWidth(grapheme: string): number {
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
