import { z } from 'zod';
import type { Task, TaskId } from '../../core/schemas/task.js';
import { taskId } from '../../core/schemas/task.js';
import { FileActionSchema } from '../../core/schemas/enums.js';
import { topoSort } from '../../core/state/topo-sort.js';
import { parseSimpleYamlFrontmatter, extractFrontmatter } from '../../utils/frontmatter.js';
import { extractFirstFencedBlock } from '../parsers/code-patterns.js';
import { isPathConfined } from '../../lib/path-confinement.js';
import { TASK_BRIEF_HEADINGS } from './headings.js';
import { error, matches } from '../../utils/error.js';

const TaskFrontmatterSchema = z.object({
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

type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;

export const parseTasksError = {
  invalidTaskBlock: (detail: string) =>
    error('parse-tasks-invalid-block', `Invalid task block: ${detail}`, { detail }),
  isInvalidTaskBlock: matches('parse-tasks-invalid-block'),
} as const;

export type ParseTasksOptions = {
  strict?: boolean;
};

export function parseTasks(tasksMarkdown: string, options?: ParseTasksOptions): Task[] {
  const tasks = parseTaskBlocksFromMarkdown(tasksMarkdown, options?.strict ?? false);
  return topoSort(tasks);
}

export function parseTasksStrict(tasksMarkdown: string): Task[] {
  return parseTasks(tasksMarkdown, { strict: true });
}

export function parseTaskBlocksStrict(tasksMarkdown: string): Task[] {
  return parseTaskBlocksFromMarkdown(tasksMarkdown, true);
}

function parseTaskBlocksFromMarkdown(tasksMarkdown: string, strict: boolean): Task[] {
  const stripped = normalizeTaskSeparators(stripFileFrontmatter(tasksMarkdown));
  const blocks = splitTaskBlocks(stripped);
  const tasks: Task[] = [];

  for (const block of blocks) {
    const task = parseTaskBlock(block);
    if (task) {
      tasks.push(task);
      continue;
    }
    if (strict && looksLikeTaskBlock(block)) {
      const reason = taskBlockParseFailure(block);
      throw parseTasksError.invalidTaskBlock(reason);
    }
  }

  return tasks;
}

function looksLikeTaskBlock(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed.startsWith('---')) return false;
  return /\bid:\s*\S/.test(trimmed);
}

function taskBlockParseFailure(block: string): string {
  const raw = parseSimpleYamlFrontmatter(block);
  if (!raw) return 'malformed YAML frontmatter';
  const result = TaskFrontmatterSchema.safeParse(raw);
  if (!result.success) {
    return result.error.issues.map((issue) => issue.message).join('; ');
  }
  return 'missing required task sections';
}

function normalizeTaskSeparators(content: string): string {
  return content.replace(/([^\r\n])---(\r?\n(?=id:\s*))/g, '$1\n---$2');
}

export function stripFileFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match?.[1]?.includes('generated_by:')) return content;
  return content.slice(match[0].length);
}

export function splitTaskBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split('\n');
  let current: string[] = [];
  let state: 'idle' | 'in-frontmatter' | 'in-body' = 'idle';
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
    }

    const isSeparator = !inFence && trimmed === '---';

    if (state === 'idle' && isSeparator) {
      current = [line];
      state = 'in-frontmatter';
    } else if (state === 'in-frontmatter' && isSeparator) {
      current.push(line);
      state = 'in-body';
    } else if (state === 'in-body' && isSeparator) {
      blocks.push(current.join('\n'));
      current = [line];
      state = 'in-frontmatter';
    } else {
      current.push(line);
    }
  }

  if (state === 'in-body' && current.length > 0) {
    blocks.push(current.join('\n'));
  }

  return blocks;
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

function extractTaskFrontmatter(block: string): TaskFrontmatter | null {
  const raw = parseSimpleYamlFrontmatter(block);
  if (!raw) return null;

  const result = TaskFrontmatterSchema.safeParse(raw);
  return result.success ? result.data : null;
}

type Sections = {
  description: string;
  signature: string;
  tests: string[];
  constraints: string[];
  pattern: string;
  currentCode: string;
  typeDefs: string;
  implementationSteps: string[];
  scopeInBounds: string[];
  scopeOutOfBounds: string[];
  scopeApprovedOutOfBounds: string[];
  escalation: string[];
  evidence: string[];
};

function readSection(sectionMap: Record<string, string>, ...headers: readonly string[]): string {
  for (const header of headers) {
    const exact = sectionMap[header];
    if (exact !== undefined) return exact;

    const prefixed = Object.entries(sectionMap).find(([key]) => key.startsWith(`${header} (`));
    if (prefixed) return prefixed[1];
  }

  return '';
}

function extractSections(block: string): Sections {
  const { body } = extractFrontmatter(block);

  const sectionMap: Record<string, string> = {};
  let currentHeader = '';
  const lines = body.split('\n');

  for (const line of lines) {
    const headerMatch = line.match(/^###\s+(.+)/);
    if (headerMatch?.[1]) {
      currentHeader = headerMatch[1].trim().toLowerCase();
    } else if (currentHeader) {
      sectionMap[currentHeader] = (sectionMap[currentHeader] ?? '') + line + '\n';
    }
  }

  const scopeText = sectionMap['scope'] ?? '';
  const { inBounds, outOfBounds, approvedOutOfBounds } = extractScopeBuckets(scopeText);

  return {
    description: readSection(sectionMap, ...TASK_BRIEF_HEADINGS.description.keys).trim(),
    signature: extractCodeBlock(readSection(sectionMap, ...TASK_BRIEF_HEADINGS.signature.keys)),
    tests: extractListItems(readSection(sectionMap, ...TASK_BRIEF_HEADINGS.tests.keys)),
    constraints: extractListItems(readSection(sectionMap, ...TASK_BRIEF_HEADINGS.constraints.keys)),
    pattern: readSection(sectionMap, ...TASK_BRIEF_HEADINGS.pattern.keys).trim(),
    currentCode: extractCodeBlock(
      readSection(sectionMap, ...TASK_BRIEF_HEADINGS.currentCode.keys),
    ).trim(),
    typeDefs: extractCodeBlock(readSection(sectionMap, ...TASK_BRIEF_HEADINGS.typeDefs.keys)),
    implementationSteps: extractNumberedItems(
      readSection(sectionMap, ...TASK_BRIEF_HEADINGS.implementationSteps.keys),
    ),
    scopeInBounds: inBounds,
    scopeOutOfBounds: outOfBounds,
    scopeApprovedOutOfBounds: approvedOutOfBounds,
    escalation: extractListItems(readSection(sectionMap, ...TASK_BRIEF_HEADINGS.escalation.keys)),
    evidence: extractListItems(readSection(sectionMap, ...TASK_BRIEF_HEADINGS.evidence.keys)),
  };
}

function extractScopeBuckets(text: string): {
  inBounds: string[];
  outOfBounds: string[];
  approvedOutOfBounds: string[];
} {
  if (!text.trim()) return { inBounds: [], outOfBounds: [], approvedOutOfBounds: [] };

  type Bucket = 'in' | 'out' | 'approved' | null;
  let bucket: Bucket = null;
  const inBounds: string[] = [];
  const outOfBounds: string[] = [];
  const approvedOutOfBounds: string[] = [];

  for (const line of text.split('\n')) {
    const labelMatch = line.match(/^\s*\*\*(.+?):\*\*\s*(.*)$/);
    if (labelMatch?.[1] !== undefined) {
      const label = labelMatch[1].trim().toLowerCase();
      if (label === 'in bounds' || label === 'in-bounds' || label === 'in') bucket = 'in';
      else if (label === 'out of bounds' || label === 'out-of-bounds' || label === 'out')
        bucket = 'out';
      else if (
        label === 'approved out of bounds' ||
        label === 'approved-out-of-bounds' ||
        label === 'approved'
      )
        bucket = 'approved';
      else bucket = null;
      continue;
    }
    const itemMatch = line.match(/^-\s+(.*)/);
    if (itemMatch?.[1] !== undefined && bucket) {
      const value = itemMatch[1].trim();
      if (bucket === 'in') inBounds.push(value);
      else if (bucket === 'out') outOfBounds.push(value);
      else approvedOutOfBounds.push(value);
    }
  }

  return { inBounds, outOfBounds, approvedOutOfBounds };
}

function extractCodeBlock(text: string): string {
  const block = extractFirstFencedBlock(text);
  if (block !== null) return block;
  return text.trim();
}

function extractListItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^-\s+(.*)/);
    if (m?.[1] !== undefined) items.push(m[1].trim());
  }
  return items;
}

function extractNumberedItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\d+\.\s+(.*)/);
    if (m?.[1] !== undefined) items.push(m[1].trim());
  }
  return items;
}
