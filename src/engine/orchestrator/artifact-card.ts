import { join } from 'node:path';
import type { Phase } from '../../core/schemas/enums.js';
import { sessionDir } from '../../core/paths.js';
import {
  getTerminalCellWidth,
  iterateTerminalGraphemes,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import type { EventBus } from '../events/types.js';

const EXCERPT_MAX_ROWS = 10;
const EXCERPT_MAX_LINE_CELLS = 200;
const OUTLINE_TITLE_MAX_CELLS = 44;
const BRIEF_HEADER_MAX_LINES = 12;
const INDENT = '  ';
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;
const HEADING_LINE = /^(#{1,6})\s+(\S.*?)(?:\s+#+)?\s*$/;
const YAML_FIELD = /^([A-Za-z_]+):[ \t]*(.*)$/;
const NARRATION_OPENER = /^(?:I['’](?:ll|m|ve|d)\b|I \b|I(?:'|’)|Let(?:'|’)?s? me\b|Let me\b)/;
const CODE_SPAN = /(`+)[^`]*?\1/g;
const STRONG_STAR = /\*\*(?=\S)(.*?\S)\*\*/g;
const STRONG_UNDERSCORE = /(^|[^\w])__(?=\S)(.*?\S)__(?!\w)/g;
const EM_STAR = /\*(?=\S)([^*]*?\S)\*/g;
const EM_UNDERSCORE = /(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g;

/** What one excerpt row stands for, and therefore what `omittedCount` counts. */
export type ExcerptUnit = 'line' | 'section' | 'task';

export interface ArtifactExcerpt {
  lineCount: number;
  excerpt: string[];
  omittedCount: number;
  omittedUnit: ExcerptUnit;
}

interface Heading {
  index: number;
  depth: number;
  title: string;
}

interface Outline {
  rows: string[];
  total: number;
}

/**
 * Preview of a persisted planner artifact, plus how many more of whatever the rows are the
 * document holds. The transcript carries this instead of the document body — the body lives in
 * the artifact file and the review column.
 *
 * A leading slice is the wrong preview for these documents: planners open with first-person
 * process narration, and `tasks.md` opens with frontmatter, so the first lines describe the run
 * rather than the artifact. The preview is chosen in this order:
 *
 * 1. the document from its first real content, when the rest fits — nothing is selected, so
 *    nothing can be selected wrong;
 * 2. its outline — Task Brief ids and titles, else its sections with their sizes;
 * 3. a slice from the same starting point, which is the fallback when neither outline exists.
 *
 * Every row is a display string, not a file byte: block heading markers and paired inline
 * emphasis are removed in all three paths so one card never carries two grammars. Nothing is
 * interpreted — no emphasis is applied, no link resolved, no code span touched.
 */
export function buildArtifactExcerpt(text: string, filename: string): ArtifactExcerpt {
  const lines = documentLines(text);
  const lineCount = lines.length;
  if (lineCount === 0) return { lineCount, excerpt: [], omittedCount: 0, omittedUnit: 'line' };

  const structure = structuralLines(lines);
  const start = sliceStart(structure, filename);
  if (lineCount - start <= EXCERPT_MAX_ROWS) return slice(lines, structure, start, filename);

  const outline = outlineOf(structure, lines, filename);
  if (outline !== null) return outline;
  return slice(lines, structure, start, filename);
}

export function publishArtifactWritten(input: {
  bus: EventBus;
  phase: Phase;
  projectDir: string;
  sessionId: string;
  filename: string;
  text: string;
}): void {
  const { lineCount, excerpt, omittedCount, omittedUnit } = buildArtifactExcerpt(
    input.text,
    input.filename,
  );
  if (excerpt.length === 0) return;
  input.bus.publish({
    type: 'artifact_written',
    ts: Date.now(),
    phase: input.phase,
    filename: input.filename,
    path: join(sessionDir(input.projectDir, input.sessionId), input.filename),
    lineCount,
    excerpt,
    omittedCount,
    omittedUnit,
  });
}

function documentLines(text: string): string[] {
  const lines = stripFrontmatter(text).split('\n');
  while (lines.at(-1)?.trim() === '') lines.pop();
  while (lines[0]?.trim() === '') lines.shift();
  return lines;
}

function stripFrontmatter(text: string): string {
  const match = FRONTMATTER_BLOCK.exec(text);
  if (match === null || !(match[1] ?? '').includes('generated_by:')) return text;
  return text.slice(match[0].length);
}

/**
 * Rows are the document's own lines, blank ones included, so the card mirrors its shape and the
 * omitted count is exactly the lines the card does not carry. Lines under a heading indent, which
 * is the hierarchy the stripped `#` markers used to supply.
 */
function slice(
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

function outlineOf(
  structure: readonly string[],
  lines: readonly string[],
  filename: string,
): ArtifactExcerpt | null {
  const outline = outlineIn(structure, lines.length, filename);
  if (outline !== null) return outline;
  // A fence holding most of the document is the planner wrapping its whole reply, not a sample
  // inside it, so the document is what the fence holds — read it before giving up on structure.
  const fenced = structure.filter((line, index) => line === '' && lines[index] !== '').length;
  return fenced * 2 > lines.length ? outlineIn(lines, lines.length, filename) : null;
}

function outlineIn(
  structure: readonly string[],
  lineCount: number,
  filename: string,
): ArtifactExcerpt | null {
  const briefs = briefOutline(structure);
  if (briefs.total > 0) return outlineExcerpt(lineCount, briefs, 'task');
  const sections = sectionOutline(structure, filename);
  return sections.total > 0 ? outlineExcerpt(lineCount, sections, 'section') : null;
}

function outlineExcerpt(lineCount: number, outline: Outline, unit: ExcerptUnit): ArtifactExcerpt {
  return {
    lineCount,
    excerpt: outline.rows,
    omittedCount: outline.total - outline.rows.length,
    omittedUnit: unit,
  };
}

/** `id` and `title` of every Task Brief block, which is what a `tasks.md` is a list of. */
function briefOutline(structure: readonly string[]): Outline {
  const briefs: { id: string; title: string }[] = [];
  for (let index = 0; index < structure.length; index++) {
    if (structure[index]?.trim() !== '---') continue;
    const end = Math.min(index + 1 + BRIEF_HEADER_MAX_LINES, structure.length);
    let id = '';
    let title = '';
    let close = index + 1;
    for (; close < end && structure[close]?.trim() !== '---'; close++) {
      const field = YAML_FIELD.exec(structure[close] ?? '');
      if (field?.[1] === 'id') id = unquote(field[2] ?? '');
      else if (field?.[1] === 'title') title = unquote(field[2] ?? '');
    }
    if (close >= end || id === '' || title === '') continue;
    briefs.push({ id, title: stripEmphasis(title) });
    index = close;
  }
  const shown = briefs.slice(0, EXCERPT_MAX_ROWS);
  const idWidth = columnWidth(shown.map((brief) => brief.id));
  return {
    rows: shown.map((brief) => clip(`${pad(brief.id, idWidth)}${INDENT}${brief.title}`)),
    total: briefs.length,
  };
}

/**
 * Sections of the shallowest heading level that has more than one of them and never repeats a
 * title, plus the level below it when those titles are distinct too. Repetition means the level
 * is a per-section template — every Task Brief carries the same `### Description`, `### Tests` —
 * and listing it describes the form, not the document. Each row carries the section's own span,
 * so the reader sees where the document's weight sits and children read as contained.
 */
function sectionOutline(structure: readonly string[], filename: string): Outline {
  const headings = documentHeadings(structure, filename);
  const primary = outlineDepth(headings, 0);
  if (primary === null) return { rows: [], total: 0 };
  const child = outlineDepth(headings, primary);
  const nested = headings.filter((entry) => entry.depth === primary || entry.depth === child);
  // Nesting is shown only when the whole nested outline fits. Half a level of children would
  // trade a complete list of the document's sections for a detailed view of its first few.
  const entries =
    nested.length <= EXCERPT_MAX_ROWS
      ? nested
      : headings.filter((entry) => entry.depth === primary);
  const shown = entries.slice(0, EXCERPT_MAX_ROWS);
  const labels = shown.map(
    (entry) => (entry.depth === primary ? '' : INDENT) + clipTitle(entry.title),
  );
  const sizes = shown.map((entry) => sectionSize(structure, headings, entry));
  const labelWidth = columnWidth(labels);
  const sizeWidth = columnWidth(sizes);
  return {
    rows: shown.map(
      (_, index) =>
        `${pad(labels[index] ?? '', labelWidth)}${INDENT}${padStart(sizes[index] ?? '', sizeWidth)}`,
    ),
    // Every section the outline does not carry is omitted, including the deeper levels it chose
    // not to nest — a complete top level is not a complete list of the document's sections.
    total: headings.length,
  };
}

function documentHeadings(structure: readonly string[], filename: string): Heading[] {
  const headings: Heading[] = [];
  for (const [index, line] of structure.entries()) {
    const match = HEADING_LINE.exec(line);
    if (match === null) continue;
    const title = stripEmphasis(match[2] ?? '');
    if (isFilenameEcho(title, filename)) continue;
    headings.push({ index, depth: (match[1] ?? '').length, title });
  }
  return headings;
}

/**
 * The card header already names the artifact, so a heading that only repeats its name is the
 * identical-label defect rather than a section, in every path.
 */
function isFilenameEcho(title: string, filename: string): boolean {
  const echo = title.toLowerCase();
  return echo === filename.toLowerCase() || echo === filename.replace(/\.[^.]+$/, '').toLowerCase();
}

function outlineDepth(headings: readonly Heading[], deeperThan: number): number | null {
  for (let depth = deeperThan + 1; depth <= 6; depth++) {
    const titles = headings.filter((heading) => heading.depth === depth).map((h) => h.title);
    if (titles.length >= 2 && new Set(titles).size === titles.length) return depth;
  }
  return null;
}

function sectionSize(
  structure: readonly string[],
  headings: readonly Heading[],
  entry: Heading,
): string {
  const next = headings.find(
    (heading) => heading.index > entry.index && heading.depth <= entry.depth,
  );
  const size = (next?.index ?? structure.length) - entry.index;
  return `${size} ${size === 1 ? 'line' : 'lines'}`;
}

/**
 * Where the preview should start: past the planner's first-person narration paragraphs, then at
 * the first heading when the text before it would have fit in the preview anyway. Skipping
 * further than the preview reaches would hide the document instead of its throat-clearing.
 */
function sliceStart(structure: readonly string[], filename: string): number {
  let index = 0;
  while (index < structure.length) {
    while (index < structure.length && (structure[index] ?? '').trim() === '') index++;
    if (!NARRATION_OPENER.test((structure[index] ?? '').trim())) break;
    while (index < structure.length && (structure[index] ?? '').trim() !== '') index++;
  }
  // A document that is nothing but narration still gets shown: it is what the planner wrote.
  if (index >= structure.length) return 0;
  const heading = documentHeadings(structure, filename).find((entry) => entry.index >= index);
  if (heading === undefined) return index;
  const preamble = structure
    .slice(index, heading.index)
    .filter((line) => line.trim() !== '').length;
  return preamble < EXCERPT_MAX_ROWS ? heading.index : index;
}

/**
 * The document with fenced regions blanked out, so samples inside them read as neither headings
 * nor Task Brief delimiters. Indices stay aligned with the source lines.
 */
function structuralLines(lines: readonly string[]): string[] {
  const structure: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const marker = FENCE_LINE.exec(line)?.[0].trim() ?? null;
    if (fence === null && marker === null) {
      structure.push(line);
      continue;
    }
    if (fence === null) fence = marker;
    else if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length) {
      fence = null;
    }
    structure.push('');
  }
  return structure;
}

/**
 * Paired inline emphasis removed, never interpreted: the markers go, the words stay, and code
 * spans are left exactly as written because a `*` inside one is literal. An unpaired marker is
 * left alone — half a pair reads worse than the syntax it replaced.
 */
function stripEmphasis(text: string): string {
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

function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

function columnWidth(values: readonly string[]): number {
  return values.reduce((widest, value) => Math.max(widest, getTerminalCellWidth(value)), 0);
}

function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - getTerminalCellWidth(value)));
}

function padStart(value: string, width: number): string {
  return ' '.repeat(Math.max(0, width - getTerminalCellWidth(value))) + value;
}

function clipTitle(title: string): string {
  return truncateTerminalDisplayText(title, OUTLINE_TITLE_MAX_CELLS);
}

function clip(line: string): string {
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
