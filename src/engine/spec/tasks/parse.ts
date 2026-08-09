import type { Task, TaskId } from '../../../core/schemas/task.js';
import { taskId } from '../../../core/schemas/task.js';
import { topoSort } from '../../../core/state/topo-sort.js';
import { error, matches } from '../../../utils/error.js';
import {
  fenceMarkerLength,
  looksLikeTaskBlock,
  normalizeTaskSeparators,
  opensUnterminatedFrontmatter,
  readTaskFrontmatter,
  splitTaskBlocks,
  unwrapFencedTaskDocument,
} from './blocks.js';
import { extractSections, warnUnknownSections } from './sections.js';

function stripFileFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match?.[1]?.includes('generated_by:')) return content;
  return content.slice(match[0].length);
}

export const parseTasksError = {
  invalidTaskBlock: (detail: string) =>
    error('parse-tasks-invalid-block', `Invalid task block: ${detail}`, { detail }),
  isInvalidTaskBlock: matches('parse-tasks-invalid-block'),
  unterminatedTaskBlock: () =>
    error('parse-tasks-unterminated-block', 'unterminated task block after separator'),
  isUnterminatedTaskBlock: matches('parse-tasks-unterminated-block'),
} as const;

export type ParseTasksOptions = {
  strict?: boolean;
  onWarning?: (message: string) => void;
};

/**
 * Zero tasks stays an empty result rather than becoming a thrown error: `planning/quick.ts`
 * persists the planner's raw output only after this call returns, and `planning/call-loop.ts`
 * retries a zero-task planner call — both need a value back. The reason travels through
 * `onWarning` instead, and this function never returns an empty array for non-empty input
 * without having emitted one. A reply whose whole document is wrapped in a ``` code fence
 * (with or without prose around it) is unwrapped via {@link unwrapFencedTaskDocument} and
 * re-parsed before the zero-task verdict; fences inside briefs that parse are untouched.
 */
export function parseTasks(tasksMarkdown: string, options?: ParseTasksOptions): Task[] {
  const tasks = parseTaskBlocksFromMarkdown(tasksMarkdown, {
    strict: options?.strict ?? false,
    ...(options?.onWarning !== undefined && { onWarning: options.onWarning }),
  });
  return topoSort(tasks);
}

/** Same reporting as {@link parseTasks}, except a rejected task-shaped block throws. */
export function parseTasksStrict(
  tasksMarkdown: string,
  onWarning?: (message: string) => void,
): Task[] {
  return parseTasks(tasksMarkdown, {
    strict: true,
    ...(onWarning !== undefined && { onWarning }),
  });
}

export interface TaskSourceBlock {
  id: string;
  source: string;
}

export function parseTaskSourceBlocks(tasksMarkdown: string): TaskSourceBlock[] {
  const stripped = normalizeTaskSeparators(stripFileFrontmatter(tasksMarkdown));
  const result: TaskSourceBlock[] = [];
  for (const block of splitTaskBlocks(stripped)) {
    const parsed = parseTaskBlock(block);
    if (parsed.ok) result.push({ id: parsed.task.id, source: block.trim() });
  }
  if (result.length === 0) {
    const unwrapped = unwrapFencedTaskDocument(stripped);
    if (unwrapped !== null) return parseTaskSourceBlocks(unwrapped);
  }
  return result;
}

/**
 * Rejections are deferred, not emitted mid-loop, because the unwrap decision needs to see them:
 * the fenced-document rescue runs only when the first pass found nothing task-shaped at all —
 * no task, no rejection, no strict failure. A reply that did carry a brief and had it rejected
 * keeps its precise frontmatter diagnostic instead, since unwrapping there would discard the
 * diagnostic and, when the fenced region is a well-formed sample, hand back the example as the
 * run's tasks. When the unwrap re-parse does run, its result replaces the first pass entirely.
 */
function parseTaskBlocksFromMarkdown(
  tasksMarkdown: string,
  opts: { strict: boolean; onWarning?: (message: string) => void },
): Task[] {
  const stripped = normalizeTaskSeparators(stripFileFrontmatter(tasksMarkdown));
  const blocks = splitTaskBlocks(stripped);
  const tasks: Task[] = [];
  const rejectionWarnings: string[] = [];
  let strictFailure: Error | null = null;
  let rejected = 0;

  for (const block of blocks) {
    const parsed = parseTaskBlock(block);
    if (parsed.ok) {
      tasks.push(parsed.task);
      if (opts.strict && opts.onWarning) warnUnknownSections(block, parsed.task.id, opts.onWarning);
      continue;
    }
    if (opts.strict && opensUnterminatedFrontmatter(block)) {
      strictFailure ??= parseTasksError.unterminatedTaskBlock();
      continue;
    }
    if (!looksLikeTaskBlock(block)) continue;

    rejected += 1;
    if (opts.strict) strictFailure ??= parseTasksError.invalidTaskBlock(parsed.reason);
    else rejectionWarnings.push(`Task Brief block rejected — ${parsed.reason}`);
  }

  if (tasks.length === 0 && rejected === 0 && strictFailure === null) {
    const unwrapped = unwrapFencedTaskDocument(stripped);
    if (unwrapped !== null) return parseTaskBlocksFromMarkdown(unwrapped, opts);
  }
  if (strictFailure) throw strictFailure;
  for (const warning of rejectionWarnings) opts.onWarning?.(warning);
  if (tasks.length === 0 && rejected === 0) {
    const reason = noTasksReason(stripped);
    if (reason) opts.onWarning?.(reason);
  }

  return tasks;
}

function noTasksReason(stripped: string): string | null {
  const trimmed = stripped.trim();
  if (trimmed === '') return null;
  if (trimmed.split('\n').some((line) => fenceMarkerLength(line.trim()) !== null)) {
    return 'No Task Brief was parsed: the output contains a ``` code fence, but neither the fenced content nor the text around it has a --- frontmatter block with an id: field. Emit Task Briefs as top-level markdown, not inside a fence.';
  }
  return 'No Task Brief was parsed: the output has no --- delimited block with an id: field.';
}

type TaskBlockResult = { ok: true; task: Task } | { ok: false; reason: string };

function parseTaskBlock(block: string): TaskBlockResult {
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
