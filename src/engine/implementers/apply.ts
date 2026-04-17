import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Task } from '../../core/types/state-actions.js';
import { validateTaskPath } from '../../core/paths-io.js';
import { toErrorMessage } from '../../utils/format-errors.js';

const SEARCH_REPLACE_LINE_THRESHOLD = 200;

/**
 * Apply generated code to a task's target file.
 *
 * Files under {@link SEARCH_REPLACE_LINE_THRESHOLD} lines always receive a
 * whole-file overwrite; search/replace markers are only parsed for larger files.
 */
export async function applyCode(code: string, task: Task, projectDir: string): Promise<{ success: boolean; error?: string }> {
  try {
    validateTaskPath(projectDir, task.file);
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }

  const filePath = join(projectDir, task.file);
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
    // Models commonly emit a trailing newline before the `=======` / `>>>>>>>`
    // delimiter that isn't part of the intended search target. We strip
    // trailing whitespace from both halves to make matches resilient to that.
    // Tradeoff: if the user genuinely needs to match trailing whitespace, this
    // will silently lose it — acceptable for code-edit use cases.
    const search = (match[1] ?? '').trimEnd();
    const replace = (match[2] ?? '').trimEnd();

    if (!result.includes(search)) {
      return { success: false, error: `Search block not found in ${task.file}:\n${search.slice(0, 200)}` };
    }

    // Intentional: only replace first occurrence to avoid unintended multi-site edits
    result = result.replace(search, () => replace);
  }

  if (hasMarkers) {
    await writeFile(filePath, result, 'utf-8');
    return { success: true };
  }

  await writeFile(filePath, code, 'utf-8');
  return { success: true };
}
