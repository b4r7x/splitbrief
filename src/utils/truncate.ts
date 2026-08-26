import { ELLIPSIS, getTerminalCellWidth, iterateTerminalGraphemes } from './display-text.js';

export function truncateByChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const kept = text.slice(0, maxChars);
  if (kept === text) return text;
  return text.slice(0, maxChars - 1) + ELLIPSIS;
}

export function truncateByLines(text: string, maxLines: number): string {
  return text.split('\n').slice(0, maxLines).join('\n');
}

export function truncateByTailLines(text: string, maxLines: number): string {
  return text.split('\n').slice(-maxLines).join('\n');
}

export function truncateWithEllipsis(str: string, max: number): string {
  if (max <= 0) return '';
  if (getTerminalCellWidth(str) <= max) return str;

  const budget = max - getTerminalCellWidth(ELLIPSIS);
  let width = 0;
  let kept = '';
  for (const grapheme of iterateTerminalGraphemes(str)) {
    const next = width + getTerminalCellWidth(grapheme);
    if (next > budget) break;
    width = next;
    kept += grapheme;
  }
  return kept + ELLIPSIS;
}
