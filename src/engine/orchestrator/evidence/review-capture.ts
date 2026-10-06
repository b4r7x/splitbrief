import type { ReviewChange, ReviewFileEntry } from '../../../core/schemas/review-changes.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { appendReviewChanges } from '../../../core/evidence/review-changes.js';
import { warnError } from '../../../lib/warn.js';
import { hashTaskBrief } from '../../brief-hash.js';
import {
  readConfinedEntry,
  sameFileEntry,
  type FileSnapshotEntry,
} from '../approval/file-snapshots/entry.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { entryToRestore } from '../approval/file-snapshots/restore.js';
import { entryStoreDir } from '../isolation/entry-snapshot.js';

function serialized(entry: FileSnapshotEntry): ReviewFileEntry {
  return entry.kind === 'absent'
    ? null
    : {
        base64: entry.bytes.toString('base64'),
        sha256: entry.sha256,
        mode: entry.mode & 0o777,
      };
}

export async function captureTaskReviewChanges(opts: {
  ref: SessionRef;
  workspaceDir: string;
  task: Task;
  taskStartSnapshot: ChangedFilesSnapshot;
}): Promise<void> {
  const files = await getChangedFilesSinceSnapshot(opts.workspaceDir, opts.taskStartSnapshot);
  const briefHash = hashTaskBrief([opts.task]);
  const changes: ReviewChange[] = [];
  for (const file of files) {
    const identity = {
      taskId: opts.task.id,
      briefHash,
      path: file,
    };
    try {
      const before = await entryToRestore(
        opts.workspaceDir,
        opts.taskStartSnapshot,
        file,
        entryStoreDir(opts.ref),
      );
      const after = await readConfinedEntry(opts.workspaceDir, file);
      if (sameFileEntry(before, after)) continue;
      changes.push({
        ...identity,
        kind: 'captured',
        before: serialized(before),
        after: serialized(after),
      });
    } catch {
      changes.push({ ...identity, kind: 'unknown', reason: 'capture-failed' });
    }
  }
  try {
    appendReviewChanges(opts.ref, changes);
  } catch (err) {
    warnError('Could not record task completion changes for review', err);
  }
}
