import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { isInDeclaredSet } from '../../../core/scope/declared-set.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { diffFileEntries } from '../../../lib/git/entry-diff.js';
import { orderChangedFiles } from '../../change-detection.js';
import type { ConsultPromptInput } from '../../spec/prompts/consult/types.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/changed-since.js';
import { readChangeEntry } from '../approval/file-snapshots/entry/read.js';
import { entryToRestore } from '../approval/file-snapshots/restore.js';
import { entryStoreDir } from '../isolation/entry-snapshot.js';

async function taskFileDiff(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
  file: string,
  ref: SessionRef,
): Promise<string> {
  try {
    const before = await entryToRestore(projectDir, snapshot, file, entryStoreDir(ref));
    const after = await readChangeEntry(projectDir, file);
    return await diffFileEntries({
      path: file,
      before: before.kind === 'absent' ? null : before,
      after: after.kind === 'absent' ? null : after,
    });
  } catch {
    // The diff is context for the answer; a file that cannot be read must not stop the call.
    return '';
  }
}

/**
 * The task's diff: what is on disk now against the lineage's start, the workspace when its
 * first brief dispatched. It holds every attempt, revision and split subtask of the task. The
 * brief's own files are diffed, in the brief's order; every other changed file is only named.
 * Null when no start is recorded (a task not dispatched yet, or an older state).
 */
export async function taskDiff(
  projectDir: string,
  state: WorkflowState,
  task: Task,
  ref: SessionRef,
): Promise<ConsultPromptInput['taskDiff']> {
  const start = state.lineages?.[lineageIdOf(task)]?.startSnapshot;
  if (start === undefined) return null;
  let files: string[];
  try {
    files = await getChangedFilesSinceSnapshot(projectDir, start);
  } catch {
    // The diff is context for the answer; a workspace that cannot be read must not stop the call.
    return null;
  }
  const briefFiles = files.filter((file) => isInDeclaredSet(file, task.suggestedFiles));
  const diffs: { path: string; diff: string }[] = [];
  for (const file of orderChangedFiles(briefFiles, task.suggestedFiles)) {
    const diff = await taskFileDiff(projectDir, start, file, ref);
    if (diff !== '') diffs.push({ path: file, diff });
  }
  return { diffs, otherFiles: files.filter((file) => !briefFiles.includes(file)) };
}
