import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { loadState } from '../../../core/state/persistence.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { captureWorkspaceSnapshot } from '../isolation/entry-snapshot.js';
import { listIgnoredPaths } from '../../../lib/git/files.js';
import { commitWorkflowState, stateOpsError } from '../state-ops.js';

export async function withAttemptRestoreScope<T>(opts: {
  ref: SessionRef;
  dir: string;
  taskStartSnapshot: ChangedFilesSnapshot | null;
  attemptSnapshot?: ChangedFilesSnapshot | undefined;
  run: () => Promise<T>;
}): Promise<T> {
  const { ref, dir, taskStartSnapshot, attemptSnapshot } = opts;
  if (taskStartSnapshot === null) return opts.run();
  const snapshots =
    attemptSnapshot === undefined ? [taskStartSnapshot] : [taskStartSnapshot, attemptSnapshot];
  for (const snapshot of snapshots) snapshot.restoreFiles ??= [];
  const start = await captureWorkspaceSnapshot(dir, ref);
  // A file ignored at the start has no saved bytes: one the call only made visible, by
  // dropping its ignore rule, is not the call's write, and a revert would delete it.
  const ignored = await listIgnoredPaths(start.ignoreProjectDir ?? dir);
  const recordWrites = async (): Promise<void> => {
    const written = (await getChangedFilesSinceSnapshot(dir, start)).filter(
      (file) =>
        !ignored.some((path) => file === path || (path.endsWith('/') && file.startsWith(path))),
    );
    const state = loadState(ref);
    const activeTaskSnapshot = state?.changedFilesBaseline?.activeTaskSnapshot;
    const scopes =
      activeTaskSnapshot === undefined ? snapshots : [...snapshots, activeTaskSnapshot];
    for (const snapshot of scopes) {
      snapshot.restoreFiles = [...new Set([...(snapshot.restoreFiles ?? []), ...written])].sort();
    }
    if (state?.changedFilesBaseline !== undefined && activeTaskSnapshot !== undefined) {
      const saved = commitWorkflowState({
        ref,
        expected: state,
        next: {
          ...state,
          changedFilesBaseline: {
            ...state.changedFilesBaseline,
            activeTaskSnapshot,
          },
        },
      });
      if (saved.kind === 'conflict') throw stateOpsError.changedOnDisk(ref.sessionId);
      if (saved.kind === 'durability-uncertain') {
        throw stateOpsError.durabilityUncertain(ref.sessionId);
      }
    }
  };
  try {
    return await opts.run();
  } finally {
    await recordWrites();
  }
}
