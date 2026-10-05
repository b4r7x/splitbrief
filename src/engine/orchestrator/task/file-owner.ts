import { isAbsolute, relative } from 'node:path';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { TriageInput } from '../../../core/schemas/review.js';
import { isTaskCompleted, type Task } from '../../../core/schemas/task.js';
import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';
import { typedEntries } from '../../../utils/type-guards.js';
import { extractFailureKeys } from '../validation/extract-failure-keys.js';
import type { FullSuiteFailureKeys } from '../validation/types.js';

const FAILURE_KEY_FILE = /^(.*?\.\w+?)(?:\(|::|:)/;

/** The file a full-suite failure key names; null when the key names no file. */
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
): string | undefined {
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

export function buildFullSuiteInputs(input: {
  newFailures: FullSuiteFailureKeys;
  tasks: readonly Task[];
  ledger: EvidenceLedger | null;
  idPrefix: 'P' | 'B';
  place: 'before review' | 'at a batch boundary';
}): TriageInput[] {
  const seen = new Set<string>();
  const inputs: TriageInput[] = [];
  for (const [stage, keys] of typedEntries<string, string[] | undefined>(input.newFailures)) {
    for (const key of keys ?? []) {
      const file = fileFromFailureKey(key);
      if (file !== null) {
        if (seen.has(file)) continue;
        seen.add(file);
      }
      const owner =
        file === null ? undefined : lastTaskChangingFile(input.ledger, input.tasks, file);
      inputs.push({
        id: `${input.idPrefix}${inputs.length + 1}`,
        kind: 'defect',
        source: 'check',
        file,
        text: `The ${stage} full-suite check ${input.place} failed: ${key}. ${
          owner === undefined ? 'No task changed it.' : `Last changed by ${owner}.`
        }`,
      });
    }
  }
  return inputs;
}
