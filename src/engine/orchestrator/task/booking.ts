import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { lineageHasOpenBrief } from '../../../core/state/machine.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { unbookedFiles } from '../evidence/task.js';

/**
 * Where a brief's lineage started, and the files of it that a settling brief books besides its
 * own. A rewrite or a split child starts from a fresh snapshot, so the files of the revisions and
 * the split parent before it are in no brief's own files. The brief that settles last books them:
 * every file changed since the lineage started that no other brief of the run booked. While
 * another brief of the lineage is open, `files` is empty. A state that recorded no lineage start
 * has none.
 */
export async function lineageRemainder(opts: {
  ref: SessionRef;
  workspaceDir: string;
  state: WorkflowState;
  task: Task;
}): Promise<{ since: ChangedFilesSnapshot; files: string[] } | undefined> {
  const { state, task } = opts;
  const key = lineageIdOf(task);
  const since = state.lineages?.[key]?.startSnapshot;
  if (since === undefined) return undefined;
  if (lineageHasOpenBrief(state.tasks, key, task.id)) return { since, files: [] };
  const changed = await getChangedFilesSinceSnapshot(opts.workspaceDir, since);
  return { since, files: unbookedFiles(opts.ref, task, changed) };
}
