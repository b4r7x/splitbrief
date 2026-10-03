import type { Task } from '../../../core/schemas/task.js';
import type { TaskSpec } from '../../../core/schemas/plan.js';
import { confinedReadFile } from '../../../lib/confined-fs.js';
import { sha256Hex } from '../../../utils/sha256.js';

/** A missing file's hash: the hash of no content, which is also how an empty file hashes. */
export const ABSENT_INPUT_HASH = sha256Hex('');

/**
 * Every path a task spec declares as input: what it reads and every file it
 * suggests, whether it already exists or not; a missing file hashes as absent,
 * so a suggested file an earlier task creates still moves under the brief.
 */
export function specInputFiles(spec: Pick<TaskSpec, 'suggestedFiles' | 'contextFiles'>): string[] {
  return [...new Set([...spec.suggestedFiles, ...spec.contextFiles])];
}

/** The input paths a compiled task recorded. */
export function taskInputFiles(task: Pick<Task, 'inputHashes'>): string[] {
  return Object.keys(task.inputHashes ?? {});
}

function hashOf(projectDir: string, file: string): string {
  try {
    return sha256Hex(confinedReadFile(projectDir, file) ?? '');
  } catch {
    // An unreadable or escaped path is evidence of nothing; it hashes as absent.
    return ABSENT_INPUT_HASH;
  }
}

/** The current content hashes of the input files, keyed by path; a missing file hashes as absent. */
export function inputHashesNow(
  projectDir: string,
  files: readonly string[],
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = hashOf(projectDir, file);
  return hashes;
}

/** The files whose current content differs from the recorded hash, a missing file included. */
export function movedInputFiles(
  recorded: Record<string, string>,
  current: Record<string, string>,
): string[] {
  return Object.keys(current).filter(
    (file) => current[file] !== (recorded[file] ?? ABSENT_INPUT_HASH),
  );
}

/** Whether the task's recorded input hashes still match the checkout. A task that records none is not stale. */
export function inputsMoved(projectDir: string, task: Task): boolean {
  if (task.inputHashes === undefined) return false;
  const files = taskInputFiles(task);
  return movedInputFiles(task.inputHashes, inputHashesNow(projectDir, files)).length > 0;
}
