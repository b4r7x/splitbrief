import { normalizeProjectRelativePath } from '../../utils/path-patterns.js';
import { REVIEW_CHECK_ID } from '../schemas/review.js';
import type { Check, Task } from '../schemas/task.js';

/** A path in a failure key; its extension starts with a letter, so a version such as `1.0.0` is none. */
export const FAILURE_KEY_PATH = String.raw`[\w./\\-]+\.[A-Za-z]\w*`;
const FAILURE_KEY_FILE = new RegExp(String.raw`^(${FAILURE_KEY_PATH})(?:$|::\S|\(\d+,\d+\)|:\d+)`);
const FIX_BRIEF_EVIDENCE_RULE =
  'Evidence, ledger, review and session files are not your job; SPLITBRIEF records them. You may edit any ordinary project file the fix needs.';
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

export type FixCheckKeys = { failureKeys: readonly string[]; redKeys: readonly string[] };

/** Per check id, the task's own failures and every failure of the original red, each once. */
export function fixCheckKeys(task: Task): Map<string, FixCheckKeys> {
  const checks = new Map<string, FixCheckKeys>();
  for (const finding of task.fix?.findings ?? []) {
    for (const id of new Set([
      ...Object.keys(finding.failureKeys ?? {}),
      ...Object.keys(finding.redKeys ?? {}),
    ])) {
      const keys = finding.failureKeys?.[id] ?? [];
      const previous = checks.get(id);
      checks.set(id, {
        failureKeys: [...new Set([...(previous?.failureKeys ?? []), ...keys])],
        redKeys: [...new Set([...(previous?.redKeys ?? []), ...(finding.redKeys?.[id] ?? [])])],
      });
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
function pairFailureKeys(carried: readonly string[], rerun: readonly string[]) {
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

/** A red with absent own keys needs an original other failure to prove the failure source ran. */
export function judgeFixCheck(
  carried: FixCheckKeys,
  failure: { keys: readonly string[]; placeholder?: string | undefined } | null,
): { own: number; left: string[]; others: number; proven: boolean } | null {
  const own = carried.failureKeys.length;
  if (own === 0 || failure?.placeholder !== undefined) return null;
  if (failure === null) return { own, left: [], others: 0, proven: true };
  const { matched, remaining } = pairFailureKeys(carried.failureKeys, failure.keys);
  const otherRed = pairFailureKeys(carried.failureKeys, carried.redKeys).remaining;
  const originalOthers = carried.redKeys.filter((_key, index) => otherRed.has(index));
  const rerunOthers = failure.keys.filter((_key, index) => remaining.has(index));
  return {
    own,
    left: carried.failureKeys.filter((_key, index) => matched.has(index)),
    others: remaining.size,
    proven:
      carried.redKeys.length > 0 &&
      (matched.size > 0 || pairFailureKeys(originalOthers, rerunOthers).matched.size > 0),
  };
}

export function fixCheckVerdict(input: {
  own: number;
  ownLeft: number;
  others: number;
  proven: boolean;
}): string[] {
  const { own, ownLeft, others, proven } = input;
  if (ownLeft > 0) {
    return [
      own === 1
        ? 'your 1 failure remains'
        : `${ownLeft} of your ${own} failures ${ownLeft === 1 ? 'remains' : 'remain'}`,
    ];
  }
  if (!proven)
    return [`your ${own} ${own === 1 ? 'failure' : 'failures'} not shown`, 'not proven fixed'];
  return [
    `your ${own} ${own === 1 ? 'failure' : 'failures'} gone`,
    ...(others > 0 ? [`${others} ${others === 1 ? 'other' : 'others'} left`] : []),
  ];
}

/** A fence longer than any backtick run in the output, so the output cannot close it. */
function fenced(output: string): string {
  const longest = (output.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 2);
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${output}\n${fence}`;
}

export function fixBriefDescription(intent: string, findings: readonly FixFinding[]): string {
  const outputs = new Set(findings.flatMap((finding) => finding.output ?? []));
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
    ...[...outputs].map((output) => `Failing output:\n${fenced(output)}`),
    FIX_BRIEF_EVIDENCE_RULE,
    FIX_BRIEF_NO_CHANGE_RULE,
  ].join('\n\n');
}
