import { z } from 'zod';
import type { Task, TaskId } from '../../core/schemas/task.js';
import { taskId } from '../../core/schemas/task.js';
import { topoSort } from '../../core/state/topo-sort.js';
import { parseSimpleYamlFrontmatter, extractFrontmatter } from '../../utils/frontmatter.js';
import { extractFirstFencedBlock } from '../parsers/code-patterns.js';

const TaskFrontmatterSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  action: z.enum(['create', 'modify']),
  file: z.string().min(1),
  depends_on: z.union([
    z.array(z.string()),
    z.string().transform(s => [s]),
  ]).optional().default([]),
});

type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;

export function parseTasks(tasksMarkdown: string): Task[] {
  const stripped = stripFileFrontmatter(tasksMarkdown);
  const blocks = splitTaskBlocks(stripped);
  const tasks = blocks.map(parseTaskBlock).filter((t): t is Task => t !== null);
  return topoSort(tasks);
}

export function stripFileFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match?.[1]?.includes('generated_by:')) return content;
  return content.slice(match[0].length);
}

function splitTaskBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split('\n');
  let current: string[] = [];
  let state: 'idle' | 'in-frontmatter' | 'in-body' = 'idle';

  for (const line of lines) {
    const isSeparator = line.trim() === '---';

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

  return {
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
}

function extractTaskFrontmatter(block: string): TaskFrontmatter | null {
  const raw = parseSimpleYamlFrontmatter(block);
  if (!raw) return null;

  const result = TaskFrontmatterSchema.safeParse(raw);
  return result.success ? result.data : null;
}

interface Sections {
  description: string;
  signature: string;
  tests: string[];
  constraints: string[];
  pattern: string;
  typeDefs: string;
  implementationSteps: string[];
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

  return {
    description: (sectionMap['description'] ?? '').trim(),
    signature: extractCodeBlock(sectionMap['signature'] ?? ''),
    tests: extractListItems(sectionMap['tests'] ?? ''),
    constraints: extractListItems(sectionMap['constraints'] ?? ''),
    pattern: (sectionMap['pattern'] ?? '').trim(),
    typeDefs: extractCodeBlock(sectionMap['type definitions'] ?? ''),
    implementationSteps: extractNumberedItems(sectionMap['implementation steps'] ?? ''),
  };
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
