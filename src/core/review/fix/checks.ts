import { oneLineDisplayText } from '../../../utils/display-text/sanitize.js';
import { fileFromFailureKey, isTestNodeKey, type FixCheckKeys } from './task.js';

function diagnosticIdentity(key: string): string | null {
  const file = fileFromFailureKey(key);
  if (file === null || isTestNodeKey(key)) return null;
  return `${file}${key.slice(file.length).replace(/^(?:\(\d+,\d+\)|:\d+(?::\d+)?)/, '')}`;
}

/** Pair exact keys first, then diagnostic identities, each re-run key at most once. */
export function pairFailureKeys(input: { carried: readonly string[]; rerun: readonly string[] }) {
  const { carried, rerun } = input;
  const remaining = new Set(rerun.map((_key, index) => index));
  const matched = new Set<number>();
  for (const [index, key] of carried.entries()) {
    const rerunIndex = rerun.findIndex((candidate, i) => candidate === key && remaining.has(i));
    if (rerunIndex < 0) continue;
    matched.add(index);
    remaining.delete(rerunIndex);
  }
  const rerunIdentities = rerun.map(diagnosticIdentity);
  for (const [index, key] of carried.entries()) {
    const identity = diagnosticIdentity(key);
    if (identity === null || matched.has(index)) continue;
    const rerunIndex = rerunIdentities.findIndex(
      (candidate, i) => candidate === identity && remaining.has(i),
    );
    if (rerunIndex < 0) continue;
    matched.add(index);
    remaining.delete(rerunIndex);
  }
  return { matched, remaining };
}

export type FixCheckJudgement = {
  own: number;
  /** Own failures the re-run still shows that no unfinished sibling carries: they fail the gate. */
  left: string[];
  /** Own failures the re-run still shows that unfinished siblings carry, left to them. */
  deferred: { key: string; taskIds: readonly string[] }[];
  /** Re-run failures the brief does not own: their fix briefs or the next review answer them. */
  others: number;
};

/**
 * A fix check settles when `left` is empty: failures the task does not own never gate it. Null
 * when the check must pass: the task carries no failure of it and is not exempt, the command
 * passes with no own failure, or the red names no failure (an incomplete capture).
 */
export function judgeFixCheck(
  carried: FixCheckKeys | undefined,
  failure: { keys: readonly string[]; placeholder?: string | undefined } | null,
): FixCheckJudgement | null {
  if (carried === undefined || failure?.placeholder !== undefined) return null;
  const own = carried.failureKeys.length;
  if (own === 0 && (failure === null || !carried.exempt)) return null;
  if (failure === null) return { own, left: [], deferred: [], others: 0 };
  const { matched, remaining } = pairFailureKeys({
    carried: carried.failureKeys,
    rerun: failure.keys,
  });
  const present = carried.failureKeys.filter((_key, index) => matched.has(index));
  return {
    own,
    left: present.filter((key) => !carried.sharedWith.has(key)),
    deferred: present.flatMap((key) => {
      const taskIds = carried.sharedWith.get(key);
      return taskIds === undefined ? [] : [{ key, taskIds }];
    }),
    others: remaining.size,
  };
}

export type FixCheckCounts = {
  own: number;
  ownLeft: number;
  deferred: number;
  deferredTo: readonly string[];
  others: number;
};

/** The counts a fix check row and its failure text show for one judgement. */
export function fixCheckCounts(judged: FixCheckJudgement): FixCheckCounts {
  return {
    own: judged.own,
    ownLeft: judged.left.length,
    deferred: judged.deferred.length,
    deferredTo: [...new Set(judged.deferred.flatMap((entry) => entry.taskIds))],
    others: judged.others,
  };
}

function failures(count: number): string {
  return `${count} ${count === 1 ? 'failure' : 'failures'}`;
}

export function checkFailureSummary(command: string, count: number): string {
  const result = command === '' ? 'failed' : `${command} failed`;
  return count === 0 ? result : `${result} · ${failures(count)}`;
}

export function runBaseFailureNote(reason: string): string {
  return `Could not verify the failure at the run base (${reason}).`;
}

// Earlier ledgers kept the prompt sent to the implementer as the finding text.
export function savedFindingText(text: string): string {
  const [heading = '', detail = ''] = text.split(/\r?\n/, 2);
  const reviewer =
    /^Reviewer check (?<id>\S+) \((?<command>.+?)\) failed (?:with new failures\.|and .*? \((?<reason>.+)\); the reviewer decides\.)(?: (?<owner>Last changed by \S+?\.|No task changed it\.))?$/.exec(
      heading,
    )?.groups;
  const check = /^check (\S+) did not pass \(fail\):\s*(.*)$/.exec(detail);
  if (reviewer?.command !== undefined && check !== null && check[1] === reviewer.id) {
    const count = /^(\d+) failures?\b|\b(\d+) (?:specs?|tests?) failed\b/i.exec(check[2] ?? '');
    const summary = checkFailureSummary(reviewer.command, Number(count?.[1] ?? count?.[2] ?? 0));
    const note = reviewer.reason === undefined ? undefined : runBaseFailureNote(reviewer.reason);
    const details = [note, reviewer.owner].filter(Boolean).join(' ');
    return oneLineDisplayText(details === '' ? summary : `${summary}. ${details}`);
  }
  const line = oneLineDisplayText(text);
  const match =
    /^(?:(Last changed by \S+?\.|No task changed it\.) )?check (\S+) did not pass \(fail\):\s*(?:(\d+) failures?\b)?/i.exec(
      line,
    );
  if (match === null) return line;
  return [match[1], checkFailureSummary(`Check ${match[2]}`, Number(match[3] ?? 0))]
    .filter(Boolean)
    .join(' ');
}

/** The fix briefs a failure is left to, as one verdict segment names them. */
export function leftTo(taskIds: readonly string[]): string {
  return taskIds.length <= 2
    ? taskIds.join(' and ')
    : `${taskIds[0]} and ${taskIds.length - 1} other fix briefs`;
}

/** The verdict segments of a fix check; each segment wraps whole. */
export function fixCheckVerdict(input: FixCheckCounts): string[] {
  const { own, ownLeft, deferred, deferredTo, others } = input;
  const rest =
    others > 0
      ? [
          `${others} ${others === 1 ? 'other' : 'others'} left for their fix briefs or the next review`,
        ]
      : [];
  const toSibling = `left to ${leftTo(deferredTo)}`;
  const gone = own - deferred;
  const segments =
    own === 0
      ? ['no failure from this brief', ...rest]
      : ownLeft > 0
        ? [
            checkFailureSummary('', ownLeft),
            ...(deferred > 0 ? [`${deferred} ${toSibling}`] : []),
            ...rest,
          ]
        : [
            ...(gone > 0
              ? [deferred === 0 ? `${failures(own)} gone` : `${gone} of ${failures(own)} gone`]
              : []),
            ...(deferred > 0
              ? [gone === 0 ? `${failures(own)} ${toSibling}` : `${deferred} ${toSibling}`]
              : []),
            ...rest,
          ];
  return segments.map((segment) => segment.replaceAll(' ', '\u00a0'));
}
