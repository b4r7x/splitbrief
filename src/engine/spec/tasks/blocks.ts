import type { Task, TaskId } from '../../../core/schemas/task.js';
import { taskId } from '../../../core/schemas/task.js';
import { fenceMarkerLength, nextFenceLength } from './fence-marker.js';
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

export function splitTaskBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split('\n');
  let current: string[] = [];
  let state: 'idle' | 'in-frontmatter' | 'in-body' = 'idle';
  let fenceLength = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    const recoversFromUnclosedFence =
      fenceLength > 0 &&
      state === 'in-body' &&
      trimmed === '---' &&
      nextNonBlankLineIsTaskId(lines, i + 1) &&
      !fenceClosesBefore(lines, i + 1, fenceLength);
    if (recoversFromUnclosedFence) fenceLength = 0;

    fenceLength = nextFenceLength(fenceLength, trimmed);

    const isSeparator = (fenceLength === 0 && trimmed === '---') || recoversFromUnclosedFence;
    const opensTaskBlock = isSeparator && nextNonBlankLineIsFrontmatterField(lines, i + 1);

    if (state === 'idle' && opensTaskBlock) {
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (fenceMarkerLength(trimmed) !== null) {
      fenceLength = nextFenceLength(fenceLength, trimmed);
      continue;
    }

    if (fenceLength > 0) continue;
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

function fenceClosesBefore(lines: string[], from: number, openLength: number): boolean {
  for (let i = from; i < lines.length; i++) {
    const marker = fenceMarkerLength((lines[i] ?? '').trim());
    if (marker !== null && marker >= openLength) return true;
  }
  return false;
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

  const { id, title, action, file } = frontmatter.data;
  const dependsOn: TaskId[] = frontmatter.data.depends_on.map(taskId);
  const sections = extractSections(block);

  const task: Task = {
    id: taskId(id),
    title,
    action,
    file,
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
