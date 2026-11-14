import {
  getTerminalCellWidth,
  iterateTerminalGraphemes,
} from '../../../utils/display-text/width.js';
import type { ArtifactExcerpt } from './types.js';

export const EXCERPT_MAX_ROWS = 10;
const EXCERPT_MAX_LINE_CELLS = 200;
export const INDENT = '  ';
export const HEADING_LINE = /^(#{1,6})\s+(\S.*?)(?:\s+#+)?\s*$/;
const CODE_SPAN = /(`+)[^`]*?\1/g;
const STRONG_STAR = /\*\*(?=\S)(.*?\S)\*\*/g;
const STRONG_UNDERSCORE = /(^|[^\w])__(?=\S)(.*?\S)__(?!\w)/g;
const EM_STAR = /\*(?=\S)([^*]*?\S)\*/g;
const EM_UNDERSCORE = /(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g;

/**
 * Rows are the document's own lines, blank ones included, so the card mirrors its shape and the
 * omitted count is exactly the lines the card does not carry. Lines under a heading indent, which
 * is the hierarchy the stripped `#` markers used to supply.
 */
export function slice(
  lines: readonly string[],
  structure: readonly string[],
  from: number,
  filename: string,
): ArtifactExcerpt {
  const rows: string[] = [];
  let shown = 0;
  let underHeading = false;
  for (let index = from; index < lines.length && rows.length < EXCERPT_MAX_ROWS; index++) {
    const line = lines[index] ?? '';
    const fenced = structure[index] === '' && line !== '';
    const heading = fenced ? null : HEADING_LINE.exec(line);
    const text = displayLine(line, fenced);
    if (heading !== null && isFilenameEcho(text, filename)) continue;
    if (rows.length === 0 && text === '') continue;
    if (heading !== null) underHeading = true;
    rows.push(text === '' || heading !== null || !underHeading ? text : INDENT + text);
    if (line.trim() !== '') shown = rows.length;
  }
  return {
    lineCount: lines.length,
    excerpt: rows.slice(0, shown),
    omittedCount: lines.length - shown,
    omittedUnit: 'line',
  };
}

function displayLine(line: string, fenced: boolean): string {
  const trimmed = line.trimEnd();
  if (fenced) return clip(trimmed);
  const heading = HEADING_LINE.exec(trimmed);
  return clip(stripEmphasis(heading === null ? trimmed : (heading[2] ?? '')));
}

/**
 * The card header already names the artifact, so a heading that only repeats its name is the
 * identical-label defect rather than a section, in every path.
 */
export function isFilenameEcho(title: string, filename: string): boolean {
  const echo = title.toLowerCase();
  return echo === filename.toLowerCase() || echo === filename.replace(/\.[^.]+$/, '').toLowerCase();
}

/**
 * Paired inline emphasis removed, never interpreted: the markers go, the words stay, and code
 * spans are left exactly as written because a `*` inside one is literal. An unpaired marker is
 * left alone — half a pair reads worse than the syntax it replaced.
 */
export function stripEmphasis(text: string): string {
  const spans = [...text.matchAll(CODE_SPAN)];
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += stripEmphasisRun(text.slice(cursor, span.index)) + span[0];
    cursor = span.index + span[0].length;
  }
  return out + stripEmphasisRun(text.slice(cursor));
}

function stripEmphasisRun(text: string): string {
  return text
    .replace(STRONG_STAR, '$1')
    .replace(STRONG_UNDERSCORE, '$1$2')
    .replace(EM_STAR, '$1')
    .replace(EM_UNDERSCORE, '$1$2');
}

export function clip(line: string): string {
  const clean = line.trimEnd();
  if (getTerminalCellWidth(clean) <= EXCERPT_MAX_LINE_CELLS) return clean;

  let width = 0;
  let result = '';
  for (const grapheme of iterateTerminalGraphemes(clean)) {
    const graphemeWidth = getTerminalCellWidth(grapheme);
    if (width + graphemeWidth > EXCERPT_MAX_LINE_CELLS) break;
    result += grapheme;
    width += graphemeWidth;
  }
  return result;
}
