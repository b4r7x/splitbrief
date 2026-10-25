import { normalizeProjectRelativePath } from '../../utils/path-patterns.js';
import { REVIEW_CHECK_ID } from '../schemas/review.js';
import { isTaskSettled, type Check, type Task } from '../schemas/task.js';

/** A path in a failure key; its extension starts with a letter, so a version such as `1.0.0` is none. */
export const FAILURE_KEY_PATH = String.raw`[\w./\\-]+\.[A-Za-z]\w*`;
const FAILURE_KEY_FILE = new RegExp(String.raw`^(${FAILURE_KEY_PATH})(?:$|::\S|\(\d+,\d+\)|:\d+)`);
const FIX_BRIEF_EVIDENCE_RULE =
  'Evidence, ledger, review and session files are not your job; SPLITBRIEF records them. You may edit any ordinary project file the fix needs.';
const FIX_BRIEF_OTHERS_RULE =
  'Other failures of these commands are not your job; their fix tasks or the next review answer them.';
const FIX_BRIEF_NO_CHANGE_RULE =
  'If no finding needs a code change, change nothing and report that.';

export type FixFinding = NonNullable<Task['fix']>['findings'][number];

/**
 * The file a failure key names: the path that leads a test node or diagnostic key, or a key that is
 * one whole path. Null when the key names no file, such as an `npm` script banner
 * (`> tsx scripts/x.ts`), a command line or a `make` error summary.
 */
export function fileFromFailureKey(key: string): string | null {
  const file = FAILURE_KEY_FILE.exec(key)?.[1];
  return file === undefined ? null : normalizeProjectRelativePath(file);
}

/** A test node key (`file::name`), as opposed to a diagnostic whose message may contain `::`. */
export function isTestNodeKey(key: string): boolean {
  return /^[^\s(:]+\.\w+::/.test(key);
}

/** The reviewer checks a fix task re-runs, each by the exact command of the red it answers. */
export function fixReviewChecks(task: Task): Check[] {
  const checks = new Map<string, Check>();
  for (const finding of task.fix?.findings ?? []) {
    for (const id of finding.checkIds ?? []) {
      const command = finding.commands?.[id];
      if (REVIEW_CHECK_ID.test(id) && command !== undefined && !checks.has(id)) {
        checks.set(id, { id, kind: 'cmd', value: command, required: true });
      }
    }
  }
  return [...checks.values()];
}

export type FixCheckKeys = {
  /** The task's own failures of this check. */
  failureKeys: readonly string[];
  /** Per own failure, the unfinished fix tasks of the same cycle that carry it too. */
  sharedWith: ReadonlyMap<string, readonly string[]>;
  /** The task owns no failure of this check, and each finding naming it owns failures of another. */
  exempt: boolean;
};

/** Per check id, the task's own failures and the command of the red they came from, if recorded. */
function ownKeys(task: Task): Map<string, { keys: string[]; command: string | undefined }> {
  const own = new Map<string, { keys: string[]; command: string | undefined }>();
  for (const finding of task.fix?.findings ?? []) {
    for (const [id, found] of Object.entries(finding.failureKeys ?? {})) {
      const known = own.get(id);
      own.set(id, {
        keys: [...new Set([...(known?.keys ?? []), ...found])],
        command: known?.command ?? finding.commands?.[id],
      });
    }
  }
  return own;
}

/**
 * Per check id, the task's own failures, each once, with the unfinished sibling fix tasks of its
 * cycle that carry the same failure: the same key under the same check id, or under another check
 * id whose red came from the same command. A check its findings name without own failures is
 * listed only when it is exempt.
 */
export function fixCheckKeys(task: Task, tasks: readonly Task[]): Map<string, FixCheckKeys> {
  const findings = task.fix?.findings ?? [];
  const siblings = tasks
    .filter(
      (other) =>
        other.id !== task.id &&
        other.fix !== undefined &&
        other.fix.cycle === task.fix?.cycle &&
        !isTaskSettled(other.status),
    )
    .map((other) => ({ id: other.id, keys: ownKeys(other) }));
  const checks = new Map<string, FixCheckKeys>();
  for (const [id, { keys: failureKeys, command }] of ownKeys(task)) {
    const sharedWith = new Map<string, string[]>();
    for (const key of failureKeys) {
      const carriers = siblings.filter((sibling) =>
        [...sibling.keys].some(
          ([otherId, other]) =>
            (otherId === id || (command !== undefined && other.command === command)) &&
            other.keys.includes(key),
        ),
      );
      if (carriers.length > 0)
        sharedWith.set(
          key,
          carriers.map((sibling) => sibling.id),
        );
    }
    checks.set(id, { failureKeys, sharedWith, exempt: false });
  }
  for (const id of new Set(findings.flatMap((finding) => finding.checkIds ?? []))) {
    const naming = findings.filter((finding) => finding.checkIds?.includes(id) === true);
    const exempt = naming.every((finding) =>
      Object.values(finding.failureKeys ?? {}).some((keys) => keys.length > 0),
    );
    if (!checks.has(id) && exempt) {
      checks.set(id, { failureKeys: [], sharedWith: new Map(), exempt: true });
    }
  }
  return checks;
}

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
  /** Re-run failures the task does not own: their fix tasks or the next review answer them. */
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

/** The fix tasks a failure is left to, as one verdict segment names them. */
export function leftTo(taskIds: readonly string[]): string {
  return taskIds.length <= 2
    ? taskIds.join(' and ')
    : `${taskIds[0]} and ${taskIds.length - 1} other fix tasks`;
}

/** The verdict segments of a fix check; each segment wraps whole. */
export function fixCheckVerdict(input: FixCheckCounts): string[] {
  const { own, ownLeft, deferred, deferredTo, others } = input;
  const rest =
    others > 0
      ? [
          `${others} ${others === 1 ? 'other' : 'others'} left for their fix tasks or the next review`,
        ]
      : [];
  const toSibling = `left to ${leftTo(deferredTo)}`;
  const gone = own - deferred;
  const segments =
    own === 0
      ? ['no failure of yours', ...rest]
      : ownLeft > 0
        ? [
            own === 1
              ? 'your 1 failure remains'
              : `${ownLeft} of your ${failures(own)} ${ownLeft === 1 ? 'remains' : 'remain'}`,
            ...(deferred > 0 ? [`${deferred} ${toSibling}`] : []),
            ...rest,
          ]
        : [
            ...(gone > 0
              ? [
                  deferred === 0
                    ? `your ${failures(own)} gone`
                    : `${gone} of your ${failures(own)} gone`,
                ]
              : []),
            ...(deferred > 0
              ? [gone === 0 ? `your ${failures(own)} ${toSibling}` : `${deferred} ${toSibling}`]
              : []),
            ...rest,
          ];
  return segments.map((segment) => segment.replaceAll(' ', '\u00a0'));
}

/** A fence longer than any backtick run in the output, so the output cannot close it. */
function fenced(output: string): string {
  const longest = (output.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 2);
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${output}\n${fence}`;
}

export function fixBriefDescription(intent: string, findings: readonly FixFinding[]): string {
  const outputs = new Set(findings.flatMap((finding) => finding.output ?? []));
  const own = [
    ...new Set(
      findings.flatMap((finding) =>
        Object.entries(finding.failureKeys ?? {}).flatMap(([id, keys]) =>
          keys.map((key) => `- ${id}: ${key}`),
        ),
      ),
    ),
  ];
  return [
    intent,
    ...findings.map(
      (finding) =>
        `**${finding.id}**: ${finding.text}${
          finding.acceptance === null ? '' : `\nAcceptance: ${finding.acceptance}`
        }${Object.entries(finding.commands ?? {})
          .map(([id, command]) => `\nCommand ${id}: ${command}`)
          .join('')}`,
    ),
    ...(own.length > 0
      ? [['Your failures, which this brief fixes:', ...own, FIX_BRIEF_OTHERS_RULE].join('\n')]
      : []),
    ...[...outputs].map((output) => `Failing output:\n${fenced(output)}`),
    FIX_BRIEF_EVIDENCE_RULE,
    FIX_BRIEF_NO_CHANGE_RULE,
  ].join('\n\n');
}
