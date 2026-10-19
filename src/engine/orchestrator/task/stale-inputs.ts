import type { Task } from '../../../core/schemas/task.js';
import type { TaskSpec } from '../../../core/schemas/plan.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import type { ContinuationHolder } from '../continuation.js';
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

/**
 * Whether the task's inputs moved in a way the plan did not expect. A task that records no hashes
 * is not stale, and neither is one whose every moved input is a file an earlier task of the plan
 * was to write: the plan ordered that change before this brief.
 */
export function inputsMovedUnexpectedly(
  projectDir: string,
  task: Task,
  earlierTasks: readonly Pick<Task, 'suggestedFiles'>[],
): boolean {
  if (task.inputHashes === undefined) return false;
  const moved = movedInputFiles(task.inputHashes, inputHashesNow(projectDir, taskInputFiles(task)));
  const expected = new Set(earlierTasks.flatMap((earlier) => earlier.suggestedFiles));
  return moved.some((file) => !expected.has(file));
}

/**
 * Whether the brief runs on its own files: it resumes its cut attempt, it replays carrying a
 * failure, or its current revision already dispatched an attempt and runs again on Try again. The
 * inputs that moved are then the brief's own output, not a change under it.
 */
export function runsOnOwnFiles(
  state: WorkflowState,
  task: Task,
  continuation: ContinuationHolder | undefined,
): boolean {
  const lineage = state.lineages?.[lineageIdOf(task)];
  return (
    continuation?.resumesAttempt(
      { kind: 'brief', taskId: task.id, attempt: state.attempt },
      hashTaskBrief([task]),
    ) === true ||
    lineage?.carriedFailure !== undefined ||
    lineage?.dispatchedRevision[task.id] === (task.revision ?? 1)
  );
}
