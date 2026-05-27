import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Task } from '../../core/schemas/task.js';
import { validateTaskPath } from '../../core/paths-io.js';
import { toErrorMessage } from '../../utils/format-errors.js';

const SEARCH_REPLACE_LINE_THRESHOLD = 200;

export async function applyCode(code: string, task: Task, projectDir: string): Promise<{ success: boolean; error?: string }> {
  let filePath: string;
  try {
    filePath = validateTaskPath(projectDir, task.file);
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }

  const dir = dirname(filePath);

  try {
    await access(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }

  if (task.action === 'create') {
    await writeFile(filePath, code, 'utf-8');
    return { success: true };
  }

  let existing: string;
  try {
    existing = await readFile(filePath, 'utf-8');
  } catch {
    await writeFile(filePath, code, 'utf-8');
    return { success: true };
  }

  const lineCount = existing.split('\n').length;

  if (lineCount < SEARCH_REPLACE_LINE_THRESHOLD) {
    await writeFile(filePath, code, 'utf-8');
    return { success: true };
  }

  const searchReplaceRegex = /<<<<<<< SEARCH\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> REPLACE/g;
  let hasMarkers = false;
  let result = existing;

  for (const match of code.matchAll(searchReplaceRegex)) {
    hasMarkers = true;
    // trimEnd makes matches resilient to trailing whitespace models commonly emit before the delimiter.
    const search = (match[1] ?? '').trimEnd();
    const replace = (match[2] ?? '').trimEnd();

    if (!result.includes(search)) {
      return { success: false, error: `Search block not found in ${task.file}:\n${search.slice(0, 200)}` };
    }

    result = result.replaceAll(search, () => replace);
  }

  if (hasMarkers) {
    await writeFile(filePath, result, 'utf-8');
    return { success: true };
  }

  await writeFile(filePath, code, 'utf-8');
  return { success: true };
}
