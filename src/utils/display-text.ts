import { redactSecrets } from './redact.js';

const ELLIPSIS = '\u2026';
const ESC = '\\u001b';
const BEL = '\\u0007';
const STRING_TERMINATOR = '\\u009c';
const CSI = '\\u009b';
const OSC = '\\u009d';
const C0_CONTROL_RANGE = '\\u0000-\\u001f';
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
const CONTROL_CHARACTER_PATTERN = new RegExp(`[${C0_CONTROL_RANGE}${C1_CONTROL_RANGE}]`, 'g');
const KEYCAP_SEQUENCE_PATTERN = /^[#*0-9]\ufe0f?\u20e3$/u;
const DEFAULT_EMOJI_PRESENTATION_PATTERN = /\p{Emoji_Presentation}/u;
const EMOJI_VARIATION_BASE_PATTERN = /\p{Extended_Pictographic}/u;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function stripTerminalControls(text: string): string {
  return text
    .replace(OSC_SEQUENCE_PATTERN, '')
    .replace(STRING_CONTROL_SEQUENCE_PATTERN, '')
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(ESCAPE_SEQUENCE_PATTERN, '')
    .replace(CONTROL_CHARACTER_PATTERN, '');
}

export function sanitizeTerminalDisplayText(text: string): string {
  return redactSecrets(stripTerminalControls(text));
}

export function getTerminalCellWidth(text: string): number {
  let width = 0;
  for (const grapheme of splitTerminalGraphemes(text)) {
    width += getGraphemeWidth(grapheme);
  }
  return width;
}

export function splitTerminalGraphemes(text: string): string[] {
  return graphemes(stripTerminalControls(text));
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

export function padTerminalDisplayTextEnd(text: string, width: number): string {
  const clean = stripTerminalControls(text);
  return `${clean}${' '.repeat(Math.max(0, width - getTerminalCellWidth(clean)))}`;
}

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
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
