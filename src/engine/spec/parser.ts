import type { Task } from '../../types.js';

export function parseTasks(tasksMarkdown: string): Task[] {
  const blocks = splitTaskBlocks(tasksMarkdown);
  const tasks: Task[] = [];

  for (const block of blocks) {
    const task = parseTaskBlock(block);
    if (task) tasks.push(task);
  }

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

  const id = frontmatter.id;
  const title = frontmatter.title;
  const action = frontmatter.action;
  const file = frontmatter.file;

  if (!id || !title || !file) {
    console.warn(`Skipping task with missing required fields (id, title, or file)`);
    return null;
  }

  if (action !== 'create' && action !== 'modify') {
    console.warn(`Skipping task ${id}: invalid action "${action}"`);
    return null;
  }

  const dependsOn = parseDependsOn(frontmatter.depends_on);
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

function extractFrontmatter(block: string): Record<string, any> | null {
  const match = block.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result: Record<string, any> = {};

  try {
    for (const line of yaml.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();

      if (key === 'depends_on') {
        if (value === '[]') {
          result[key] = [];
        } else if (value.startsWith('[') && value.endsWith(']')) {
          result[key] = value
            .slice(1, -1)
            .split(',')
            .map((s: string) => s.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean);
        } else if (value.length > 0) {
          result[key] = [value.trim()];
        } else {
          result[key] = [];
        }
      } else {
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        result[key] = value;
      }
    }
  } catch {
    console.warn('Malformed YAML frontmatter, skipping task');
    return null;
  }

  return result;
}

function parseDependsOn(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
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
  // Remove frontmatter
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
