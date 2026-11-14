import { truncateTerminalDisplayText } from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import type { Brief, ArtifactExcerpt, ExcerptUnit } from './types.js';
import {
  EXCERPT_MAX_ROWS,
  clip,
  INDENT,
  stripEmphasis,
  HEADING_LINE,
  isFilenameEcho,
} from './excerpt-lines.js';

const OUTLINE_TITLE_MAX_CELLS = 44;

interface Heading {
  index: number;
  depth: number;
  title: string;
}

interface Outline {
  rows: string[];
  total: number;
}

export function outlineOf(input: {
  structure: readonly string[];
  lines: readonly string[];
  filename: string;
  briefs: readonly Brief[] | undefined;
}): ArtifactExcerpt | null {
  const { structure, lines, filename, briefs } = input;
  if (briefs !== undefined && briefs.length > 0) {
    return outlineExcerpt(lines.length, briefOutline(briefs), 'task');
  }
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

/** `id` and `title` of every Task Brief, which is the list the run executes. */
function briefOutline(briefs: readonly Brief[]): Outline {
  const shown = briefs.slice(0, EXCERPT_MAX_ROWS);
  const idWidth = columnWidth(shown.map((brief) => brief.id));
  return {
    rows: shown.map((brief) =>
      clip(`${pad(brief.id, idWidth)}${INDENT}${briefTitle(brief.title)}`),
    ),
    total: briefs.length,
  };
}

/** A card row has no line breaks to keep. */
function briefTitle(title: string): string {
  return stripEmphasis(title.replace(/\s+/g, ' ').trim());
}

/**
 * Sections of the shallowest heading level that has more than one of them and never repeats a
 * title, plus the level below it when those titles are distinct too. Repetition means the level
 * is a per-section template — every Task Brief carries the same `### Description`, `### Tests` —
 * and listing it describes the form, not the document. Child sections read as contained.
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
  return {
    rows: labels,
    // Every section the outline does not carry is omitted, including the deeper levels it chose
    // not to nest — a complete top level is not a complete list of the document's sections. The
    // title is not one of them: it names the document rather than dividing it.
    total: headings.length - (isTitled(headings) ? 1 : 0),
  };
}

/**
 * A document is titled when its H1 stands above every other heading, as `# Spec: …` does over
 * its `##` sections. A lone H2 above H3 children is still a section the card has not shown.
 */
function isTitled(headings: readonly Heading[]): boolean {
  const [first, ...rest] = headings;
  return first?.depth === 1 && rest.every((entry) => entry.depth > first.depth);
}

export function documentHeadings(structure: readonly string[], filename: string): Heading[] {
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

function outlineDepth(headings: readonly Heading[], deeperThan: number): number | null {
  for (let depth = deeperThan + 1; depth <= 6; depth++) {
    const titles = headings.filter((heading) => heading.depth === depth).map((h) => h.title);
    if (titles.length >= 2 && new Set(titles).size === titles.length) return depth;
  }
  return null;
}

function columnWidth(values: readonly string[]): number {
  return values.reduce((widest, value) => Math.max(widest, getTerminalCellWidth(value)), 0);
}

function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - getTerminalCellWidth(value)));
}

function clipTitle(title: string): string {
  return truncateTerminalDisplayText(title, OUTLINE_TITLE_MAX_CELLS);
}
