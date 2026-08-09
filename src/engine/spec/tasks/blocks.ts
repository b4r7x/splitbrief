import YAML from 'yaml';
import { z } from 'zod';
import { FileActionSchema } from '../../../core/schemas/enums.js';
import { isPathConfined } from '../../../lib/path-confinement.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { isRecord } from '../../../utils/type-guards.js';

export const TaskFrontmatterSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  action: FileActionSchema,
  file: z
    .string()
    .min(1)
    .refine((p) => isPathConfined(p, '.'), {
      message: 'task file path must be a confined relative path',
    }),
  depends_on: z
    .union([z.array(z.string()), z.string().transform((s) => [s])])
    .optional()
    .default([]),
});

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;

export function fenceMarkerLength(trimmed: string): number | null {
  const match = trimmed.match(/^(`{3,})/);
  return match?.[1] ? match[1].length : null;
}

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

    const marker = fenceMarkerLength(trimmed);
    if (marker !== null) {
      if (fenceLength === 0) fenceLength = marker;
      else if (marker >= fenceLength) fenceLength = 0;
    }

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
    const marker = fenceMarkerLength(line.trim());
    if (marker !== null) {
      if (fenceLength === 0) fenceLength = marker;
      else if (marker >= fenceLength) fenceLength = 0;
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
    const marker = fenceMarkerLength(trimmed);
    if (marker !== null) {
      if (fenceLength === 0) fenceLength = marker;
      else if (marker >= fenceLength) fenceLength = 0;
    }
    if (fenceLength === 0 && trimmed === '---') {
      separators += 1;
      continue;
    }
    if (separators === 1 && trimmed !== '') contentAfterOpen = true;
  }
  return separators < 2 && contentAfterOpen;
}

export type TaskFrontmatterResult =
  | { ok: true; data: TaskFrontmatter }
  | { ok: false; reason: string };

const FRONTMATTER_BODY_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const ID_LINE_RE = /^id:\s*["']?([^"'\r\n]*?)["']?\s*$/m;
const FIELD_LINE_RE = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
const DIAGNOSTIC_MAX_CHARS = 60;

export function readTaskFrontmatter(block: string): TaskFrontmatterResult {
  const body = block.match(FRONTMATTER_BODY_RE)?.[1];
  if (body === undefined) return rejected(block, 'frontmatter has no closing --- delimiter');

  let parsed: unknown;
  try {
    parsed = YAML.parse(body);
  } catch (err) {
    return rejected(body, yamlFailureReason(body, err));
  }
  if (!isRecord(parsed)) return rejected(body, 'frontmatter is not a key/value mapping');

  const result = TaskFrontmatterSchema.safeParse(parsed);
  if (result.success) return { ok: true, data: result.data };
  return rejected(
    body,
    result.error.issues
      .map((issue) => fieldFailureReason(parsed, issue.path[0], issue.message))
      .join('; '),
  );
}

function rejected(source: string, detail: string): TaskFrontmatterResult {
  const id = ID_LINE_RE.exec(source)?.[1]?.trim();
  return {
    ok: false,
    reason: `${id ? `task ${id}` : 'task block with no readable id'}: ${detail}`,
  };
}

function yamlFailureReason(body: string, err: unknown): string {
  const line = yamlErrorLine(err);
  const offending = line === null ? undefined : body.split('\n')[line - 1];
  const field = offending === undefined ? null : FIELD_LINE_RE.exec(offending);
  if (field?.[1] !== undefined) {
    return `frontmatter field \`${field[1]}\` is not valid YAML: ${quoteValue((field[2] ?? '').trim())}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `frontmatter is not valid YAML: ${diagnosticText(message.split('\n')[0] ?? message)}`;
}

function yamlErrorLine(err: unknown): number | null {
  if (!isRecord(err) || !Array.isArray(err.linePos)) return null;
  const first: unknown = err.linePos[0];
  if (!isRecord(first) || typeof first.line !== 'number') return null;
  return first.line;
}

function fieldFailureReason(
  raw: Record<string, unknown>,
  key: PropertyKey | undefined,
  message: string,
): string {
  if (typeof key !== 'string') return message;
  const value = raw[key];
  return value === undefined
    ? `frontmatter field \`${key}\` is missing`
    : `frontmatter field \`${key}\` rejected ${quoteValue(value)} — ${message}`;
}

function quoteValue(value: unknown): string {
  return `"${diagnosticText(typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)))}"`;
}

/** Planner-authored text reaches a terminal callout unescaped; strip controls before quoting it. */
function diagnosticText(text: string): string {
  const clean = sanitizeTerminalDisplayText(text);
  return clean.length > DIAGNOSTIC_MAX_CHARS
    ? `${clean.slice(0, DIAGNOSTIC_MAX_CHARS - 3)}...`
    : clean;
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
