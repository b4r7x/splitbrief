import type { EvidencePromotedFile } from '../../../core/schemas/evidence.js';
import type { ReviewChange, ReviewFileEntry } from '../../../core/schemas/review-changes.js';
import type { Task } from '../../../core/schemas/task.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { appendReviewChanges } from '../../../core/evidence/review-changes.js';
import { warnError } from '../../../lib/warn.js';
import { hashTaskBrief } from '../../brief-hash.js';
import {
  readConfinedEntry,
  type AcquisitionBaseline,
  type FileSnapshotEntry,
} from '../approval/file-snapshots/entry.js';

function serialized(entry: FileSnapshotEntry): ReviewFileEntry {
  return entry.kind === 'absent'
    ? null
    : {
        base64: entry.bytes.toString('base64'),
        sha256: entry.sha256,
        mode: entry.mode & 0o777,
      };
}

/** Capture only versions verified against the acquisition and exact writer receipts. */
export async function capturePromotedReviewChanges(opts: {
  ref: SessionRef;
  task: Task;
  files: readonly EvidencePromotedFile[];
  before: ReadonlyMap<string, FileSnapshotEntry>;
  baseline: AcquisitionBaseline | undefined;
}): Promise<void> {
  const changes: ReviewChange[] = [];
  for (const receipt of opts.files) {
    const identity = {
      taskId: opts.task.id,
      briefHash: hashTaskBrief([opts.task]),
      path: receipt.path,
    };
    const before = opts.before.get(receipt.path);
    const baseline = opts.baseline?.get(receipt.path);
    const verifiedBefore =
      opts.baseline !== undefined &&
      before !== undefined &&
      (baseline === undefined
        ? before.kind === 'absent'
        : before.kind === 'file' &&
          before.sha256 === baseline.sha256 &&
          (before.mode & 0o777) === (baseline.mode & 0o777));
    if (!verifiedBefore || before === undefined) {
      changes.push({ ...identity, kind: 'unknown', reason: 'input-unverified' });
      continue;
    }
    try {
      const after = await readConfinedEntry(opts.ref.projectDir, receipt.path);
      const matches =
        after.kind === 'absent'
          ? receipt.sha256 === null && receipt.mode === null
          : after.sha256 === receipt.sha256 && (after.mode & 0o777) === receipt.mode;
      changes.push(
        matches
          ? {
              ...identity,
              kind: 'captured',
              before: serialized(before),
              after: serialized(after),
            }
          : { ...identity, kind: 'unknown', reason: 'output-changed' },
      );
    } catch {
      changes.push({ ...identity, kind: 'unknown', reason: 'capture-failed' });
    }
  }
  try {
    appendReviewChanges(opts.ref, changes);
  } catch (err) {
    // Promotion already happened. Missing review evidence must not invent ownership
    // or turn a successful write into a second application attempt.
    warnError('Could not record promotion changes for review', err);
  }
}
