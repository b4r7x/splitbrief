import { realpath } from 'node:fs/promises';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { loadState } from '../../../core/state/persistence.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/changed-since.js';
import { withCheckoutWriteLock } from '../../checkout-write.js';
import { beginCheckoutWriter, type CheckoutWrite } from '../../checkout-writers.js';
import { snapshotEntry } from '../approval/file-snapshots/restore.js';
import { checkoutFingerprint, readCheckoutFingerprint } from '../isolation/checkout-entries.js';
import { captureWorkspaceSnapshot } from '../isolation/entry-snapshot.js';
import { listIgnoredPaths } from '../../../lib/git/files.js';
import { commitWorkflowState } from '../state-ops/commit.js';
import { stateOpsError } from '../state-ops/errors.js';

export async function withAttemptRestoreScope<T>(opts: {
  ref: SessionRef;
  dir: string;
  taskStartSnapshot: ChangedFilesSnapshot | null;
  attemptSnapshot?: ChangedFilesSnapshot | undefined;
  run: () => Promise<T>;
}): Promise<T> {
  const { ref, dir, taskStartSnapshot, attemptSnapshot } = opts;
  const checkout = (await realpath(dir)) === (await realpath(ref.projectDir));
  if (taskStartSnapshot === null && !checkout) return opts.run();
  const snapshots = [taskStartSnapshot, attemptSnapshot].filter((snapshot) => snapshot != null);
  for (const snapshot of snapshots) snapshot.restoreFiles ??= [];
  const recordWrites = (written: string[]): void => {
    const state = loadState(ref);
    const activeTaskSnapshot =
      taskStartSnapshot === null ? undefined : state?.changedFilesBaseline?.activeTaskSnapshot;
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
  const writer = checkout
    ? await withCheckoutWriteLock(dir, async () => beginCheckoutWriter(ref))
    : undefined;
  let scope: { start: ChangedFilesSnapshot; ignored: string[] } | undefined;
  try {
    const start = await captureWorkspaceSnapshot(dir, ref);
    scope = { start, ignored: await listIgnoredPaths(start.ignoreProjectDir ?? dir) };
    return await opts.run();
  } finally {
    const settle = async (): Promise<void> => {
      let writes: CheckoutWrite[] | undefined;
      let written: string[] = [];
      try {
        if (scope === undefined) {
          writes = [];
        } else {
          const { start, ignored } = scope;
          // A dropped ignore rule can reveal files the call never touched.
          written = (await getChangedFilesSinceSnapshot(dir, start)).filter(
            (file) =>
              !ignored.some(
                (path) => file === path || (path.endsWith('/') && file.startsWith(path)),
              ),
          );
          if (writer !== undefined) {
            writes = await Promise.all(
              written.map(async (file): Promise<CheckoutWrite> => {
                const after = await readCheckoutFingerprint(dir, file);
                if (after === undefined || start.gitlinks?.includes(file)) return [file, null];
                const entry = await snapshotEntry(dir, start, file);
                const before = checkoutFingerprint(
                  entry.kind === 'stored' ? { ...entry, kind: 'file' } : entry,
                );
                return [file, { before, after }];
              }),
            );
          }
        }
      } finally {
        writer?.finish(writes);
      }
      if (scope !== undefined) recordWrites(written);
    };
    if (writer === undefined) await settle();
    else await withCheckoutWriteLock(dir, settle);
  }
}
