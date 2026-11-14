import { stripTerminalControls } from './sanitize.js';
import { getTerminalCellWidth, graphemes, getGraphemeWidth } from './width.js';

export const ELLIPSIS = '\u2026';

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

export function truncateByChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const kept = text.slice(0, maxChars);
  if (kept === text) return text;
  return text.slice(0, maxChars - 1) + ELLIPSIS;
}

export function truncateByTailLines(text: string, maxLines: number): string {
  return text.split('\n').slice(-maxLines).join('\n');
}
