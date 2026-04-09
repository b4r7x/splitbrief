import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Task } from '../../types.js';
import { validateTaskPath } from '../../utils/fs.js';
import { toErrorMessage } from '../../utils/format.js';

const SEARCH_REPLACE_THRESHOLD = 200;

export function applyCode(code: string, task: Task, projectDir: string): { success: boolean; error?: string } {
  try {
    validateTaskPath(projectDir, task.file);
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }

  const filePath = join(projectDir, task.file);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (task.action === 'create') {
    writeFileSync(filePath, code, 'utf-8');
    return { success: true };
  }

  if (!existsSync(filePath)) {
    writeFileSync(filePath, code, 'utf-8');
    return { success: true };
  }

  const existing = readFileSync(filePath, 'utf-8');
  const lineCount = existing.split('\n').length;

  if (lineCount < SEARCH_REPLACE_THRESHOLD) {
    writeFileSync(filePath, code, 'utf-8');
    return { success: true };
  }

  const searchReplaceRegex = /<<<<<<< SEARCH\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> REPLACE/g;
  let hasMarkers = false;
  let result = existing;

  for (let match = searchReplaceRegex.exec(code); match !== null; match = searchReplaceRegex.exec(code)) {
    hasMarkers = true;
    const search = (match[1] ?? '').trimEnd();
    const replace = (match[2] ?? '').trimEnd();

    if (!result.includes(search)) {
      return { success: false, error: `Search block not found in ${task.file}:\n${search.slice(0, 200)}` };
    }

    result = result.replace(search, () => replace);
  }

  if (hasMarkers) {
    writeFileSync(filePath, result, 'utf-8');
    return { success: true };
  }

  writeFileSync(filePath, code, 'utf-8');
  return { success: true };
}
