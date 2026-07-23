import type { Task, TaskId } from '../../../core/schemas/task.js';
import { taskId } from '../../../core/schemas/task.js';
import { topoSort } from '../../../core/state/topo-sort.js';
import { error, matches } from '../../../utils/error.js';
import {
  extractTaskFrontmatter,
  looksLikeTaskBlock,
  normalizeTaskSeparators,
  opensUnterminatedFrontmatter,
  splitTaskBlocks,
  taskBlockParseFailure,
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

export function parseTasks(tasksMarkdown: string, options?: ParseTasksOptions): Task[] {
  const tasks = parseTaskBlocksFromMarkdown(tasksMarkdown, {
    strict: options?.strict ?? false,
    ...(options?.onWarning !== undefined && { onWarning: options.onWarning }),
  });
  return topoSort(tasks);
}

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
    const task = parseTaskBlock(block);
    if (task) result.push({ id: task.id, source: block.trim() });
  }
  return result;
}

function parseTaskBlocksFromMarkdown(
  tasksMarkdown: string,
  opts: { strict: boolean; onWarning?: (message: string) => void },
): Task[] {
  const stripped = normalizeTaskSeparators(stripFileFrontmatter(tasksMarkdown));
  const blocks = splitTaskBlocks(stripped);
  const tasks: Task[] = [];

  for (const block of blocks) {
    const task = parseTaskBlock(block);
    if (task) {
      tasks.push(task);
      if (opts.strict && opts.onWarning) warnUnknownSections(block, task.id, opts.onWarning);
      continue;
    }
    if (!opts.strict) continue;
    if (opensUnterminatedFrontmatter(block)) throw parseTasksError.unterminatedTaskBlock();
    if (looksLikeTaskBlock(block)) {
      const reason = taskBlockParseFailure(block);
      throw parseTasksError.invalidTaskBlock(reason);
    }
  }

  return tasks;
}

function parseTaskBlock(block: string): Task | null {
  const frontmatter = extractTaskFrontmatter(block);
  if (!frontmatter) return null;

  const { id, title, action, file } = frontmatter;
  const dependsOn: TaskId[] = (frontmatter.depends_on ?? []).map(taskId);
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

  return task;
}
