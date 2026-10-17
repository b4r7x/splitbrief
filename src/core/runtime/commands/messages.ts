import type { RejectRunSnapshotResult } from './types.js';
import { formatTruncatedList } from '../../formatting.js';
import { countNoun } from '../../../utils/pluralize.js';

/** What a restore of an Apply backup did. `removed` is the part of `restored` that Apply had created. */
export function formatApplyRestoreCounts(result: {
  restored: readonly string[];
  removed: readonly string[];
}): string {
  const putBack = result.restored.length - result.removed.length;
  const done = [
    ...(putBack > 0 ? [`put back ${countNoun(putBack, 'replaced file')}`] : []),
    ...(result.removed.length > 0
      ? [`removed ${countNoun(result.removed.length, 'created file')}`]
      : []),
  ];
  return done.length > 0 ? done.join(', ') : 'nothing to put back';
}

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
  const savedText =
    result.savedTo === undefined ? '' : ` The replaced bytes are in ${result.savedTo}.`;
  const leftAloneText =
    result.conflictedPaths.length === 0
      ? ''
      : ` Files left as you changed them: ${formatTruncatedList(result.conflictedPaths, 5)}.`;
  return `Run rejected from snapshot ${result.snapshotId}: ${changedCount} file(s) restored/deleted${conflictText}${missingText}.${leftAloneText}${savedText}`;
}
