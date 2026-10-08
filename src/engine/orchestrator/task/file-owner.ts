import { isAbsolute, relative } from 'node:path';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import { isTaskCompleted, type Task } from '../../../core/schemas/task.js';
import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';
import { extractFailureKeys } from '../validation/extract-failure-keys.js';

const FAILURE_KEY_FILE = /^(.*?\.\w+?)(?:\(|::|:|$)/;

/** The file a failure key names; null when the key names no file. */
export function fileFromFailureKey(key: string): string | null {
  const match = FAILURE_KEY_FILE.exec(key);
  return match?.[1] === undefined ? null : normalizeProjectRelativePath(match[1]);
}

/**
 * The workspace-relative files a failing check or validation output names, in
 * first-seen order with repeats dropped. A diagnostic may quote an absolute
 * path; it is reported relative to the workspace, and a path that escapes it is
 * not a file this run can own.
 */
export function failingFilesFromOutput(output: string, workspaceDir: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const key of extractFailureKeys(output)) {
    const named = fileFromFailureKey(key);
    if (named === null) continue;
    const file = isAbsolute(named)
      ? normalizeProjectRelativePath(relative(workspaceDir, named))
      : named;
    if (file === '' || file === '..' || file.startsWith('../') || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  return files;
}

/**
 * The last completed task whose accepted changed files include `file`, newest
 * task first. Ownership comes from the evidence ledger's recorded changed files,
 * never from the brief's declared targets.
 */
export function lastTaskChangingFile(
  ledger: EvidenceLedger | null,
  tasks: readonly Task[],
  file: string,
): Task['id'] | undefined {
  const normalized = normalizeProjectRelativePath(file);
  const changed = new Map<string, readonly string[]>();
  for (const entry of ledger?.tasks ?? []) changed.set(entry.id, entry.changedFiles);
  const done = tasks.filter((task) => isTaskCompleted(task.status));
  for (let i = done.length - 1; i >= 0; i--) {
    const task = done[i];
    if (task === undefined) continue;
    const files = changed.get(task.id);
    if (files === undefined) continue;
    if (files.some((candidate) => normalizeProjectRelativePath(candidate) === normalized)) {
      return task.id;
    }
  }
  return undefined;
}
