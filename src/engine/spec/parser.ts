import type { Task } from '../../types.js';

interface TaskFrontmatter {
  id: string;
  title: string;
  action: 'create' | 'modify';
  file: string;
  depends_on?: string[];
}

export function parseTasks(tasksMarkdown: string): Task[] {
  const blocks = splitTaskBlocks(tasksMarkdown);
  const tasks = blocks.map(parseTaskBlock).filter((t): t is Task => t !== null);
  return topoSort(tasks);
}

function splitTaskBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split('\n');
  let current: string[] = [];
  let inFrontmatter = false;
  let foundFrontmatter = false;

  for (const line of lines) {
    if (line.trim() === '---') {
      if (!inFrontmatter && !foundFrontmatter) {
        inFrontmatter = true;
        current = [line];
      } else if (inFrontmatter) {
        inFrontmatter = false;
        foundFrontmatter = true;
        current.push(line);
      } else if (foundFrontmatter) {
        // New block starting  -  save previous
        blocks.push(current.join('\n'));
        current = [line];
        inFrontmatter = true;
        foundFrontmatter = false;
      }
    } else {
      current.push(line);
    }
  }

  if (foundFrontmatter && current.length > 0) {
    blocks.push(current.join('\n'));
  }

  return blocks;
}

function parseTaskBlock(block: string): Task | null {
  const frontmatter = extractFrontmatter(block);
  if (!frontmatter) return null;

  const { id, title, action, file } = frontmatter;
  const dependsOn: string[] = frontmatter.depends_on ?? [];
  const sections = extractSections(block);

  return {
    id,
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
    implSteps: sections.implSteps,
    status: 'pending',
  };
}

function parseDependsOnValue(value: string): string[] {
  if (value === '[]' || value.length === 0) return [];
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',')
      .map((s: string) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return [value.trim().replace(/^['"]|['"]$/g, '')];
}

function extractFrontmatter(block: string): TaskFrontmatter | null {
  const match = block.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const raw: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    if (key === 'depends_on') {
      raw[key] = parseDependsOnValue(value);
      continue;
    }

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    raw[key] = value;
  }

  if (typeof raw.id !== 'string' || typeof raw.title !== 'string' ||
      typeof raw.action !== 'string' || typeof raw.file !== 'string') {
    return null;
  }

  if (raw.action !== 'create' && raw.action !== 'modify') return null;

  if (raw.depends_on !== undefined && !Array.isArray(raw.depends_on)) return null;

  return {
    id: raw.id,
    title: raw.title,
    action: raw.action,
    file: raw.file,
    depends_on: raw.depends_on as string[] | undefined,
  };
}

interface Sections {
  description: string;
  signature: string;
  tests: string[];
  constraints: string[];
  pattern: string;
  typeDefs: string;
  implSteps: string[];
}

function extractSections(block: string): Sections {
  const body = block.replace(/^---\n[\s\S]*?\n---\n?/, '');

  const sectionMap: Record<string, string> = {};
  let currentHeader = '';
  const lines = body.split('\n');

  for (const line of lines) {
    const headerMatch = line.match(/^###\s+(.+)/);
    if (headerMatch) {
      currentHeader = headerMatch[1].trim().toLowerCase();
    } else if (currentHeader) {
      if (!sectionMap[currentHeader]) sectionMap[currentHeader] = '';
      sectionMap[currentHeader] += line + '\n';
    }
  }

  return {
    description: (sectionMap['description'] ?? '').trim(),
    signature: extractCodeBlock(sectionMap['signature'] ?? ''),
    tests: extractListItems(sectionMap['tests'] ?? ''),
    constraints: extractListItems(sectionMap['constraints'] ?? ''),
    pattern: (sectionMap['pattern'] ?? '').trim(),
    typeDefs: extractCodeBlock(sectionMap['type definitions'] ?? ''),
    implSteps: extractNumberedItems(sectionMap['implementation steps'] ?? ''),
  };
}

function extractCodeBlock(text: string): string {
  const match = text.match(/```[\w]*\n([\s\S]*?)```/);
  if (match) return match[1].trim();
  return text.trim();
}

function extractListItems(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.match(/^-\s+(.*)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1].trim());
}

function extractNumberedItems(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.match(/^\d+\.\s+(.*)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1].trim());
}

export function topoSort(tasks: Task[]): Task[] {
  const taskMap = new Map<string, Task>();
  for (const task of tasks) taskMap.set(task.id, task);

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: Task[] = [];

  function visit(id: string, path: string[]) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id];
      throw new Error(`Circular dependency detected: ${cycle.join(' -> ')}`);
    }

    const task = taskMap.get(id);
    if (!task) return;

    visiting.add(id);
    for (const depId of task.dependsOn) {
      visit(depId, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
    sorted.push(task);
  }

  for (const task of tasks) {
    visit(task.id, []);
  }

  return sorted;
}
