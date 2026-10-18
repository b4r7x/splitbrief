import type { RejectRunSnapshotResult } from './types.js';
import { formatTruncatedList } from '../../formatting.js';
import { countNoun } from '../../../utils/pluralize.js';
import { capitalize } from '../../../utils/capitalize.js';

/**
 * What a restore did, for an Apply backup and for a checkout reject. `removed` is the part of
 * `restored` that Apply or the run had created.
 */
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

/** Why End run and Discard refuse a run whose Apply did not finish. */
export const APPLY_UNFINISHED_REFUSAL =
  'Apply did not finish. Restore or retry Apply first, then end the run.';

/** What `/run reject confirm` did to the checkout, as the run's transcript records it. */
export type RunRejectFacts = Readonly<{
  restored: readonly string[];
  removed: readonly string[];
  conflicted: readonly string[];
  missing: number;
  savedTo?: string | undefined;
}>;

export function runRejectFacts(
  result: Extract<RejectRunSnapshotResult, { status: 'rejected' }>,
): RunRejectFacts {
  return {
    restored: [...result.restoredPaths, ...result.deletedPaths],
    removed: result.deletedPaths,
    conflicted: result.conflictedPaths,
    missing: result.missingSnapshotFiles.length,
    ...(result.savedTo !== undefined && { savedTo: result.savedTo }),
  };
}

function leftBehind(facts: RunRejectFacts): boolean {
  return facts.conflicted.length > 0 || facts.missing > 0;
}

/**
 * The whole result of a reject: what it put back and removed, the paths it left as you changed them
 * (five named, the rest counted), the files it had no copy of, and the folder that holds what it
 * replaced.
 */
export function formatRejectRunMessage(facts: RunRejectFacts): string {
  const conflicts = facts.conflicted.length;
  return [
    `${capitalize(formatApplyRestoreCounts(facts))}.`,
    ...(conflicts === 0
      ? []
      : [
          `${countNoun(conflicts, 'file')} left as you changed ${conflicts === 1 ? 'it' : 'them'}: ${formatTruncatedList([...facts.conflicted], 5)}.`,
        ]),
    ...(facts.missing === 0
      ? []
      : [`${countNoun(facts.missing, 'file')} had no saved copy to put back.`]),
    ...(facts.savedTo === undefined ? [] : [`The replaced files are saved in ${facts.savedTo}.`]),
    ...(leftBehind(facts) ? ['The run stays open, so you can reject it again.'] : []),
  ].join(' ');
}

/** The feedback line points at the transcript row, which holds the whole result. */
export function rejectRunFeedback(facts: RunRejectFacts): { message: string; isError: boolean } {
  return leftBehind(facts)
    ? { message: 'Run rejected in part · the transcript names what it left', isError: true }
    : { message: 'Run rejected · the transcript names what it put back', isError: false };
}
