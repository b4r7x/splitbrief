import { isTaskCompleted, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { lineageFilesToBook, lineageHasOpenBrief } from '../../../core/state/lineage.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/changed-since.js';
import { unbookedFiles } from '../evidence/task.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';

/**
 * Where a brief's lineage started, and the files of it that a settling brief books besides its
 * own. A rewrite or a split child starts from a fresh snapshot, so the files of the revisions and
 * the split parent before it are in no brief's own files. Of the files changed since the lineage
 * started that no other brief of the run booked, a passing brief books the ones it names, and the
 * brief that closes the lineage books the rest (`lineageFilesToBook`). `closes` tells whether the
 * brief closes the lineage; a skip books the files only then. A state that recorded no lineage
 * start has none.
 */
export async function lineageRemainder(opts: {
  ref: SessionRef;
  workspaceDir: string;
  state: WorkflowState;
  task: Task;
}): Promise<{ since: ChangedFilesSnapshot; files: string[]; closes: boolean } | undefined> {
  const { state, task } = opts;
  const key = lineageIdOf(task);
  const since = state.lineages?.[key]?.startSnapshot;
  if (since === undefined) return undefined;
  const changed = await getChangedFilesSinceSnapshot(opts.workspaceDir, since);
  const closes = !lineageHasOpenBrief(state.tasks, key, task.id);
  return {
    since,
    files: lineageFilesToBook(task, closes, unbookedFiles(opts.ref, task, changed)),
    closes,
  };
}

/**
 * The task starts of the briefs that a rewrite or a split of the brief's lineage replaced, newest
 * first, with the writes of their attempts, which a skip that closes the lineage takes back in
 * turn. Each one leaves the files that a brief done since it started booked: an earlier split
 * child, or a fix brief between two children. A skip that leaves a brief of the lineage open takes
 * nothing back, because that brief continues on the files.
 */
export function replacedAttemptWrites(
  ref: SessionRef,
  state: WorkflowState,
  task: Task,
): ChangedFilesSnapshot[] {
  const key = lineageIdOf(task);
  if (lineageHasOpenBrief(state.tasks, key, task.id)) return [];
  const done = state.tasks
    .filter((brief) => isTaskCompleted(brief.status))
    .map((brief) => brief.id);
  const ledger = readEvidenceLedger(ref)?.tasks ?? [];
  return (state.lineages?.[key]?.replacedStarts ?? [])
    .map(({ snapshot, doneAtStart }) => {
      const kept = new Set(
        ledger
          .filter((entry) => done.includes(entry.id) && !doneAtStart.includes(entry.id))
          .flatMap((entry) => entry.changedFiles),
      );
      return {
        ...snapshot,
        restoreFiles: (snapshot.restoreFiles ?? []).filter((file) => !kept.has(file)),
      };
    })
    .reverse();
}
