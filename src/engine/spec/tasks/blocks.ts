import type { Task, TaskId } from '../../../core/schemas/task.js';
import { taskId } from '../../../core/schemas/task.js';
import { closesOpenFence, fenceMarkerLength, nextFenceLength } from './fence-marker.js';
import { readTaskFrontmatter, TaskFrontmatterSchema } from './frontmatter.js';
import { extractSections } from './sections.js';

/**
 * A fence is content when it sits inside a Task Brief; it is wrapping when the
 * whole document lives inside it. Planners sometimes reply with prose narration
 * around a ```-fenced tasks.md, which hides every `---` separator from
 * {@link splitTaskBlocks}. This collects the contents of top-level fenced
 * regions that contain task-brief structure — a `---` line and an `id:` line —
 * and returns them joined, dropping the fence markers and the narration outside
 * them. Returns null when no fenced region carries task structure. Callers only
 * invoke this after a parse produced zero task blocks, so a document with
 * legitimate fences inside parsed briefs is never rewritten.
 *
 * A wrapper is closed by a marker at least as long as the opener, or by end of
 * input. Two further conditions keep the brief's own fences from closing it,
 * which matters when the planner picks a wrapper exactly as long as the fences
 * inside the briefs — a ```markdown around briefs carrying ```javascript,
 * measured against Claude Code on 2026-08-07:
 *
 * - a line carrying an info string never closes anything. CommonMark forbids an
 *   info string on a closing fence, so ```javascript can only open.
 * - the fences already passed must pair up. A brief's code blocks contribute two
 *   lines each, so a candidate reached across an odd number of them is the
 *   closer of one of those blocks, not of the wrapper.
 *
 * Without them the region ended at the brief's first code sample and every
 * section after it was dropped: the task parsed with an id and nothing else, and
 * the brief quality gate failed the run.
 */
export function unwrapFencedTaskDocument(content: string): string | null {
  const lines = content.split('\n');
  const regions: string[] = [];
  let openIndex = -1;
  let openLength = 0;
  let innerFences = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    const marker = fenceMarkerLength(trimmed);
    if (marker === null) continue;
    if (openIndex === -1) {
      openIndex = i;
      openLength = marker;
      innerFences = 0;
    } else if (closesFencedRegion(trimmed, marker, openLength, innerFences)) {
      regions.push(lines.slice(openIndex + 1, i).join('\n'));
      openIndex = -1;
    } else {
      innerFences += 1;
    }
  }
  if (openIndex !== -1) regions.push(lines.slice(openIndex + 1).join('\n'));

  const taskShaped = regions.filter(containsTaskStructure);
  if (taskShaped.length === 0) return null;
  return taskShaped.join('\n');
}

function closesFencedRegion(
  trimmed: string,
  marker: number,
  openLength: number,
  innerFences: number,
): boolean {
  if (marker < openLength) return false;
  if (trimmed.slice(marker).trim() !== '') return false;
  return innerFences % 2 === 0;
}

function containsTaskStructure(text: string): boolean {
  let sawSeparator = false;
  let sawId = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '---') sawSeparator = true;
    else if (/^id:\s*\S/.test(trimmed)) sawId = true;
    if (sawSeparator && sawId) return true;
  }
  return false;
}

/**
 * A non-fenced `---` delimits a Task Brief only when a frontmatter field follows it. Planners
 * write `---` as a horizontal rule before phase headings and after the last brief, and taking
 * those for delimiters rejected whole plans (`task block with no readable id`, `unterminated
 * task block after separator`). The names are the closed set from {@link TaskFrontmatterSchema}
 * rather than a generic `word:` pattern, which sign-off prose such as `Note: …` also matches —
 * that reopens a block nothing ever closes. The value may be empty so `id:` still opens a block
 * and still earns its schema diagnostic.
 */
const FRONTMATTER_FIELD_LINE_RE = new RegExp(
  `^(?:${Object.keys(TaskFrontmatterSchema.shape).join('|')})\\s*:`,
);

export function splitTaskBlocks(markdown: string, onWarning?: (message: string) => void): string[] {
  const blocks: string[] = [];
  const lines = markdown.split('\n');
  let current: string[] = [];
  let state: 'idle' | 'in-frontmatter' | 'in-body' = 'idle';
  let fenceLength = 0;
  let fenceInfo = '';
  let fenceOpenedAt = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    const insideOpenFence = fenceLength > 0 && state === 'in-body';
    const gluedSeparator = insideOpenFence ? splitGluedSeparator(line) : null;
    const bareHeaderInFence =
      insideOpenFence && trimmed === '---' && nextNonBlankLineIsTaskId(lines, i + 1);
    const gluedHeaderInFence = gluedSeparator !== null && nextNonBlankLineIsTaskId(lines, i + 1);
    const recoversFromUnclosedFence =
      (bareHeaderInFence || gluedHeaderInFence) &&
      fenceEndsAtBriefHeader({ lines, header: i, fenceLength, fenceOpenedAt });
    if (recoversFromUnclosedFence) {
      onWarning?.(
        `${briefName(current, 0)} never closes its ${(lines[fenceOpenedAt] ?? '').trim()} code fence, so the rest of the brief is read as code; the fence ends at ${briefName(lines, i)}`,
      );
      fenceLength = 0;
      fenceInfo = '';
    } else if (bareHeaderInFence && !opensSampleOfFormat(lines, fenceOpenedAt)) {
      // A fence that opens on a brief header is a sample of the format. Any other fence that holds
      // a header may hold a brief the planner meant, so the brief it keeps as code is named.
      onWarning?.(
        `${briefName(current, 0)} holds the header of ${briefName(lines, i)} in its ${(lines[fenceOpenedAt] ?? '').trim()} code fence, so ${briefName(lines, i)} is read as code, not as a brief`,
      );
    }

    const markerLength = fenceMarkerLength(trimmed);
    if (markerLength !== null) {
      const markerInfo = trimmed.slice(markerLength).trim();
      if (fenceLength === 0) {
        fenceLength = markerLength;
        fenceInfo = markerInfo;
        fenceOpenedAt = i;
      } else if (closesOpenFence({ fenceLength, fenceInfo, markerLength, markerInfo })) {
        fenceLength = 0;
        fenceInfo = '';
      }
    }

    const isSeparator = (fenceLength === 0 && trimmed === '---') || recoversFromUnclosedFence;
    const opensTaskBlock = isSeparator && nextNonBlankLineIsFrontmatterField(lines, i + 1);

    if (recoversFromUnclosedFence && gluedSeparator !== null) {
      // The separator was glued to the last code line of the unclosed fence: the brief that owns
      // the fence keeps the code text, and the separator opens the next brief.
      current.push(gluedSeparator.body);
      blocks.push(current.join('\n'));
      current = [gluedSeparator.separator];
      state = 'in-frontmatter';
    } else if (state === 'idle' && opensTaskBlock) {
      current = [line];
      state = 'in-frontmatter';
    } else if (state === 'in-frontmatter' && isSeparator) {
      current.push(line);
      state = 'in-body';
    } else if (state === 'in-body' && opensTaskBlock) {
      blocks.push(current.join('\n'));
      current = [line];
      state = 'in-frontmatter';
    } else {
      current.push(line);
    }
  }

  if (state !== 'idle' && current.length > 0) {
    blocks.push(current.join('\n'));
  }

  return blocks;
}

export function normalizeTaskSeparators(content: string): string {
  const lines = content.split('\n');
  let fenceLength = 0;
  let fenceInfo = '';
  let fenceOpenedAt = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    const markerLength = fenceMarkerLength(trimmed);
    if (markerLength !== null) {
      const markerInfo = trimmed.slice(markerLength).trim();
      if (fenceLength === 0) {
        fenceLength = markerLength;
        fenceInfo = markerInfo;
        fenceOpenedAt = i;
      } else if (closesOpenFence({ fenceLength, fenceInfo, markerLength, markerInfo })) {
        fenceLength = 0;
        fenceInfo = '';
      }
      continue;
    }

    if (fenceLength > 0) {
      // Glue inside an actually unclosed fence belongs to the next brief — the same decision
      // splitTaskBlocks makes — so repair it; a header in a closed sample stays code.
      const briefHeaderInFence =
        (trimmed === '---' || /[^\r]---\r?$/.test(line)) && nextNonBlankLineIsTaskId(lines, i + 1);
      if (!briefHeaderInFence) continue;
      if (!fenceEndsAtBriefHeader({ lines, header: i, fenceLength, fenceOpenedAt })) continue;
      fenceLength = 0;
      fenceInfo = '';
    }

    if (!/^id:/.test(lines[i + 1] ?? '')) continue;
    lines[i] = line.replace(/([^\r])---(\r?)$/, '$1\n---$2');
  }

  return lines.join('\n');
}

export function looksLikeTaskBlock(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed.startsWith('---')) return false;
  return /\bid:\s*\S/.test(trimmed);
}

export function opensUnterminatedFrontmatter(block: string): boolean {
  if (!block.trim().startsWith('---')) return false;
  const lines = block.split('\n');
  let fenceLength = 0;
  let separators = 0;
  let contentAfterOpen = false;
  for (const line of lines) {
    const trimmed = line.trim();
    fenceLength = nextFenceLength(fenceLength, trimmed);
    if (fenceLength === 0 && trimmed === '---') {
      separators += 1;
      continue;
    }
    if (separators === 1 && trimmed !== '') contentAfterOpen = true;
  }
  return separators < 2 && contentAfterOpen;
}

/**
 * Splits a line whose separator lost its preceding newline — the planner wrote
 * `const cut = 1;---` — into the code text and the separator. A line that is exactly `---`
 * (with an optional `\r`) carries no glue and returns null.
 */
function splitGluedSeparator(line: string): { body: string; separator: string } | null {
  const match = /[^\r]---\r?$/.exec(line);
  if (match === null) return null;
  const separator = match[0].slice(1);
  return { body: line.slice(0, line.length - separator.length), separator };
}

function nextNonBlankLineIsTaskId(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '') continue;
    return /^id:\s*\S/.test(trimmed);
  }
  return false;
}

function nextNonBlankLineIsFrontmatterField(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '') continue;
    return FRONTMATTER_FIELD_LINE_RE.test(trimmed);
  }
  return false;
}

/**
 * A brief header inside an open code fence reads two ways: the fence was never closed and the
 * header starts the next brief, or the header is text in a code sample whose later markers close
 * the fence. The header stays code only when that is the one reading under which every marker
 * pairs up — the open fence closes through the markers after the header. If ending the fence at
 * the header also closes, or keeping it open does not, the header starts a brief. Pairing spans
 * the whole rest of the document, so a sample two briefs down decides a header above it, and the
 * same fence line repeated inside its own fence closes it (validator finding, 2026-09-26).
 *
 * The header the fence itself opened on is never recovered, whatever the markers say: an
 * md/markdown fence whose first content is a Task Brief header — ```md before a quoted T900,
 * whose `---` may be glued to sample text — is a sample of the format, so that header stays
 * quoted. A header further down the same fence is not a sample: a genuine T002 after the quoted
 * content, or after an unclosed ```ts, still ends the fence and starts a block (validator finding,
 * 2026-09-26).
 */
function fenceEndsAtBriefHeader(input: {
  lines: string[];
  header: number;
  fenceLength: number;
  fenceOpenedAt: number;
}): boolean {
  const { lines, header, fenceLength, fenceOpenedAt } = input;
  if (fenceOpenedOnHeader({ lines, header, fenceOpenedAt })) return false;
  const opener = (lines[fenceOpenedAt] ?? '').trim();
  const marker = fenceMarkerLength(opener);
  const openerInfo = marker === null ? '' : opener.slice(marker).trim();
  if (!fenceRunCloses({ lines, from: header + 1, openLength: fenceLength, openInfo: openerInfo }))
    return true;
  return fenceRunCloses({ lines, from: header + 1, openLength: 0, openInfo: '' });
}

/** True when the markers from `from` pair up and every fence they open is closed at the end. */
function fenceRunCloses(input: {
  lines: string[];
  from: number;
  openLength: number;
  openInfo: string;
}): boolean {
  const { lines, from, openLength, openInfo } = input;
  let fenceLength = openLength;
  let fenceInfo = openInfo;
  for (let i = from; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    const marker = fenceMarkerLength(trimmed);
    if (marker === null) continue;
    const info = trimmed.slice(marker).trim();
    if (fenceLength === 0) {
      fenceLength = marker;
      fenceInfo = info;
    } else if (
      closesOpenFence({ fenceLength, fenceInfo, markerLength: marker, markerInfo: info })
    ) {
      fenceLength = 0;
      fenceInfo = '';
    }
  }
  return fenceLength === 0;
}

/** Info strings that announce a sample of the markdown format the Task Briefs themselves use. */
const MARKDOWN_SAMPLE_INFO_RE = /^(?:md|markdown)$/;

/**
 * True when the fence that opened at `fenceOpenedAt` announces the markdown format and holds
 * `header` as its first content: a bare `---`, or sample text glued to one (`example---` before
 * an `id:` line). Only md/markdown owns either form: an md/markdown fence is a sample of the
 * format, while a bare `---` or the same glue in a code fence — ```ts before `const cut = 1;---`
 * — is the document's next separator, not quoted text. A bare opener is excluded: it may be the
 * closer of an earlier sample that an unclosed fence made the parser read as an opener.
 */
function fenceOpenedOnHeader(input: {
  lines: string[];
  header: number;
  fenceOpenedAt: number;
}): boolean {
  const { lines, header, fenceOpenedAt } = input;
  const opener = (lines[fenceOpenedAt] ?? '').trim();
  const marker = fenceMarkerLength(opener);
  if (marker === null || opener.length === marker) return false;
  if (!MARKDOWN_SAMPLE_INFO_RE.test(opener.slice(marker).trim())) return false;
  for (let i = fenceOpenedAt + 1; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '') continue;
    if (i !== header) return false;
    if (trimmed === '---') return true;
    return splitGluedSeparator(lines[i] ?? '') !== null;
  }
  return false;
}

/**
 * Only a marker with an info string is certainly an opener: a closing fence carries none
 * (CommonMark), so a bare ``` before a brief header may be the closer of an earlier sample that
 * an unclosed fence made the parser read as an opener. Silencing that one would drop the brief
 * behind it without a name.
 */
function opensSampleOfFormat(lines: string[], opener: number): boolean {
  const trimmed = (lines[opener] ?? '').trim();
  const marker = fenceMarkerLength(trimmed);
  return marker !== null && trimmed.length > marker && opensOnTaskBrief(lines, opener + 1);
}

function opensOnTaskBrief(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '') continue;
    return trimmed === '---' && nextNonBlankLineIsFrontmatterField(lines, i + 1);
  }
  return false;
}

/** `Task <id>` for the brief header whose opening `---` is `lines[start]`. */
function briefName(lines: string[], start: number): string {
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '---') break;
    const id = /^id:\s*(\S.*)$/.exec(trimmed)?.[1];
    if (id !== undefined) return `Task ${id.replace(/^(["'])(.*)\1$/, '$2')}`;
  }
  return 'A Task Brief';
}

export function stripFileFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match?.[1]?.includes('generated_by:')) return content;
  return content.slice(match[0].length);
}

export type TaskBlockResult = { ok: true; task: Task } | { ok: false; reason: string };

/** Block-local schema parse: one `---` delimited Task Brief block into a Task. */
export function parseTaskBlock(block: string): TaskBlockResult {
  const frontmatter = readTaskFrontmatter(block);
  if (!frontmatter.ok) return frontmatter;

  const { id, title, action, file, files } = frontmatter.data;
  const dependsOn: TaskId[] = frontmatter.data.depends_on.map(taskId);
  const sections = extractSections(block);

  const task: Task = {
    id: taskId(id),
    title,
    action,
    file,
    ...(files !== undefined && { files }),
    dependsOn,
    description: sections.description,
    signature: sections.signature || undefined,
    tests: sections.tests,
    constraints: sections.constraints,
    pattern: sections.pattern || undefined,
    typeDefs: sections.typeDefs || '',
    implementationSteps: sections.implementationSteps,
    status: 'pending',
  };

  if (sections.currentCode) task.currentCode = sections.currentCode;

  const scope: {
    inBounds?: string[];
    outOfBounds?: string[];
    approvedOutOfBounds?: string[];
  } = {};
  if (sections.scopeInBounds.length > 0) scope.inBounds = sections.scopeInBounds;
  if (sections.scopeOutOfBounds.length > 0) scope.outOfBounds = sections.scopeOutOfBounds;
  if (sections.scopeApprovedOutOfBounds.length > 0) {
    scope.approvedOutOfBounds = sections.scopeApprovedOutOfBounds;
  }
  if (scope.inBounds || scope.outOfBounds || scope.approvedOutOfBounds) task.scope = scope;
  if (sections.escalation.length > 0) task.escalation = sections.escalation;
  if (sections.evidence.length > 0) task.evidence = sections.evidence;

  return { ok: true, task };
}
