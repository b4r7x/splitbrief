import type { ReviewChange, ReviewFileEntry } from '../../../core/schemas/review-changes.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { appendReviewChanges } from '../../../core/evidence/review-changes.js';
import { warnError } from '../../../lib/warn.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import {
  readChangeEntry,
  sameChangeEntry,
  type ChangeEntry,
} from '../approval/file-snapshots/entry.js';
import { entryToRestore } from '../approval/file-snapshots/restore.js';
import { entryStoreDir } from '../isolation/entry-snapshot.js';

function serialized(entry: ChangeEntry): ReviewFileEntry {
  if (entry.kind === 'absent') return null;
  if (entry.kind === 'symlink') return { symlink: entry.target };
  return {
    base64: entry.bytes.toString('base64'),
    sha256: entry.sha256,
    mode: entry.mode & 0o777,
  };
}

/** The review's record of the files a brief booked, each from its content at `since`. */
export async function captureTaskReviewChanges(opts: {
  ref: SessionRef;
  workspaceDir: string;
  task: Task;
  since: ChangedFilesSnapshot;
  files: readonly string[];
}): Promise<void> {
  const briefHash = hashTaskBrief([opts.task]);
  const changes: ReviewChange[] = [];
  for (const file of opts.files) {
    const identity = {
      taskId: opts.task.id,
      briefHash,
      path: file,
    };
    try {
      const before = await entryToRestore(
        opts.workspaceDir,
        opts.since,
        file,
        entryStoreDir(opts.ref),
      );
      const after = await readChangeEntry(opts.workspaceDir, file);
      if (sameChangeEntry(before, after)) continue;
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
