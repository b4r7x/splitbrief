import { join } from 'node:path';
import { sessionDir } from '../../../core/paths.js';
import { fileFrontmatter } from '../../../core/sessions/spec-files.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { EventBus } from '../../events/types.js';
import type { Brief, ArtifactExcerpt } from './types.js';
import { EXCERPT_MAX_ROWS, slice } from './excerpt-lines.js';
import { outlineOf, documentHeadings } from './outline.js';

const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;
const NARRATION_OPENER = /^(?:I['’](?:ll|m|ve|d)\b|I \b|I(?:'|’)|Let(?:'|’)?s? me\b|Let me\b)/;

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
 * 2. its outline — the ids and titles of the Task Briefs a `tasks.md` was rendered from, else
 *    its section titles;
 * 3. a slice from the same starting point, which is the fallback when neither outline exists.
 *
 * Every row is a display string, not a file byte: block heading markers and paired inline
 * emphasis are removed in all three paths so one card never carries two grammars. Nothing is
 * interpreted — no emphasis is applied, no link resolved, no code span touched.
 */
export function buildArtifactExcerpt(
  text: string,
  filename: string,
  briefs?: readonly Brief[],
): ArtifactExcerpt {
  const lines = documentLines(text);
  const lineCount = lines.length;
  if (lineCount === 0) return { lineCount, excerpt: [], omittedCount: 0, omittedUnit: 'line' };

  const structure = structuralLines(lines);
  const start = sliceStart(structure, filename);
  if (lineCount - start <= EXCERPT_MAX_ROWS) return slice(lines, structure, start, filename);

  const outline = outlineOf({ structure, lines, filename, briefs });
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
  briefs?: readonly Brief[] | undefined;
  replaced: { text: string; briefs?: readonly Brief[] } | null;
}): void {
  const { lineCount, excerpt, omittedCount, omittedUnit } = buildArtifactExcerpt(
    input.text,
    input.filename,
    input.briefs,
  );
  if (input.replaced !== null) {
    const previous = buildArtifactExcerpt(
      input.replaced.text,
      input.filename,
      input.replaced.briefs,
    );
    const unchanged =
      previous.lineCount === lineCount &&
      previous.omittedCount === omittedCount &&
      previous.omittedUnit === omittedUnit &&
      previous.excerpt.length === excerpt.length &&
      previous.excerpt.every((row, index) => row === excerpt[index]);
    if (unchanged) return;
  }
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
  const lines = text.slice(fileFrontmatter(text).length).split('\n');
  while (lines.at(-1)?.trim() === '') lines.pop();
  while (lines[0]?.trim() === '') lines.shift();
  return lines;
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
 * The document with fenced regions blanked out, so samples inside them never read as headings.
 * Indices stay aligned with the source lines.
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
