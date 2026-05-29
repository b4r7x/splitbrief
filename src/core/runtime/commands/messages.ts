import type { RejectRunSnapshotResult } from './types.js';

export function formatRejectRunMessage(
  result: Extract<RejectRunSnapshotResult, { status: 'rejected' }>,
): string {
  const changedCount = result.restoredPaths.length + result.deletedPaths.length;
  const conflictText =
    result.conflictedPaths.length > 0 ? `, ${result.conflictedPaths.length} conflict(s)` : '';
  const missingText =
    result.missingSnapshotFiles.length > 0
      ? `, ${result.missingSnapshotFiles.length} missing snapshot file(s)`
      : '';
  return `Run rejected from snapshot ${result.snapshotId}: ${changedCount} file(s) restored/deleted${conflictText}${missingText}.`;
}
