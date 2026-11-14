import { normalizeProjectRelativePath } from '../../../utils/path/patterns.js';
import { REVIEW_CHECK_ID } from '../../schemas/review/verdict.js';
import { type Task, type Check, isTaskSettled } from '../../schemas/task.js';

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

/**
 * The reviewer checks a fix task re-runs, each by the exact command of the red it answers. None
 * while End-of-run checks are off.
 */
export function fixReviewChecks(task: Task, endChecks: boolean): Check[] {
  if (!endChecks) return [];
  const checks = new Map<string, Check>();
  for (const finding of task.fix?.findings ?? []) {
    for (const id of finding.checkIds ?? []) {
      const command = finding.commands?.[id];
      if (REVIEW_CHECK_ID.test(id) && command !== undefined && !checks.has(id)) {
        checks.set(id, { id, kind: 'cmd', value: command });
      }
    }
  }
  return [...checks.values()];
}

/**
 * The check ids a fix task's findings name, each once: the ones its brief runs again, and the
 * reviewer checks it leaves off while End-of-run checks are off.
 */
export function splitFixCheckIds(task: Task, endChecks: boolean): { run: string[]; off: string[] } {
  const run: string[] = [];
  const off: string[] = [];
  for (const id of new Set(
    (task.fix?.findings ?? []).flatMap((finding) => finding.checkIds ?? []),
  )) {
    (!endChecks && REVIEW_CHECK_ID.test(id) ? off : run).push(id);
  }
  return { run, off };
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
