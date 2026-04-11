import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Task } from '../../types.js';
import { validateTaskPath } from '../../core/paths-io.js';
import { toErrorMessage } from '../../utils/format.js';

const SEARCH_REPLACE_LINE_THRESHOLD = 200;

/**
 * Apply generated code to a task's target file.
 *
 * **Threshold behavior:** Files under {@link SEARCH_REPLACE_LINE_THRESHOLD} lines
 * always receive a whole-file overwrite, even if the model emits search/replace
 * markers. Search/replace markers are only parsed for larger files. This is
 * intentional — small files are more reliably updated via full replacement.
 */
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

  if (lineCount < SEARCH_REPLACE_LINE_THRESHOLD) {
    writeFileSync(filePath, code, 'utf-8');
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
    writeFileSync(filePath, result, 'utf-8');
    return { success: true };
  }

  writeFileSync(filePath, code, 'utf-8');
  return { success: true };
}
