import {
  fixCheckVerdict,
  fileFromFailureKey,
  isTestNodeKey,
  judgeFixCheck,
  pairFailureKeys,
  type FixCheckKeys,
} from '../../../core/review/fix-task.js';
import { redactSecrets } from '../../../utils/redact.js';
import { truncateByChars } from '../../../utils/truncate.js';
import type { FailureKeys } from './extract-failure-keys.js';
import type { CheckRunResult } from './run-checks.js';
import { boundedOutputTail } from './stage.js';

/** The failure keys a failure text lists before the output tail; the rest are counted. */
const LISTED_FAILURE_KEYS = 10;
const FAILURE_LINE_CHARS = 300;

function clip(line: string): string {
  return truncateByChars(redactSecrets(line), FAILURE_LINE_CHARS);
}

function keyLines(keys: readonly string[], messages: ReadonlyMap<string, string>): string[] {
  return keys.flatMap((key) => {
    const message = messages.get(key);
    return message === undefined ? [`- ${clip(key)}`] : [`- ${clip(key)}`, `  ${clip(message)}`];
  });
}

function matchesFile(input: { key: string; file?: string | null | undefined }): boolean {
  const named = fileFromFailureKey(input.key);
  return input.file == null || named === null || named === input.file;
}

/** Unassigned keys stay visible even when the check's target supplies the input file. */
export function failureKeysForFile(input: {
  failure: FailureKeys | null;
  file?: string | null | undefined;
}): string[] {
  if (input.failure === null || input.failure.placeholder !== undefined) return [];
  return input.failure.keys.filter((key) => matchesFile({ key, file: input.file }));
}

/** The failures of a red that count against the run: every key its `preExisting` does not name. */
export function newFailureKeys(run: CheckRunResult): string[] {
  if (run.status !== 'fail') return [];
  const preExisting = run.preExisting ?? [];
  return run.failure.keys.filter((key) => !preExisting.includes(key));
}

/**
 * The text a check that did not pass hands the implementer, the consult and the reviewer. A red
 * with failure keys leads with them, each failing test with its assertion message, before the
 * output tail, so a tail of runner noise still names the failure. Each failure family gets half
 * the listed keys, with unused places going to the other family. With `carried`, the keys a fix
 * task answers, it says which of them remain and lists those first. A file-scoped input lists its
 * keys and unassigned keys without the output tail. Reviewer checks name pre-existing failures.
 */
export function checkFailureText(
  run: CheckRunResult,
  options: { carried?: FixCheckKeys | undefined; file?: string | null | undefined } = {},
): string {
  const { carried } = options;
  const scoped = options.file != null;
  const head = `check ${run.checkId} did not pass (${run.status})`;
  const output = boundedOutputTail(run.output);
  if (run.status !== 'fail' || run.failure.placeholder !== undefined) {
    const detail =
      run.status === 'fail' &&
      run.failure.placeholder !== undefined &&
      (scoped || output.trim() === '')
        ? clip(run.failure.placeholder)
        : output;
    return `${head}: ${detail}`;
  }
  const keys = failureKeysForFile({ failure: run.failure, file: options.file });
  const messages = new Map(
    [...(run.failure.messages ?? [])].filter(([, message]) =>
      matchesFile({ key: message, file: options.file }),
    ),
  );
  const judged = carried === undefined ? null : judgeFixCheck(carried, run.failure);
  const classified = judged === null && run.preExisting !== undefined;
  // A carried diagnostic may have moved lines; pre-existing keys use this run's positions.
  const { remaining } = pairFailureKeys({
    carried: judged?.left ?? run.preExisting ?? [],
    rerun: keys,
  });
  const primary = keys.filter((_key, index) =>
    classified ? remaining.has(index) : !remaining.has(index),
  );
  const others = keys.filter((_key, index) =>
    classified ? !remaining.has(index) : remaining.has(index),
  );
  const ordered = [...primary, ...others];
  const tests = ordered.filter(
    (key) => isTestNodeKey(key) || fileFromFailureKey(key) === null || messages.has(key),
  );
  const testKeys = new Set(tests);
  const diagnostics = ordered.filter((key) => !testKeys.has(key));
  const testLimit = Math.max(LISTED_FAILURE_KEYS / 2, LISTED_FAILURE_KEYS - diagnostics.length);
  const listed = new Set([
    ...tests.slice(0, testLimit),
    ...diagnostics.slice(0, LISTED_FAILURE_KEYS - Math.min(testLimit, tests.length)),
  ]);
  const listedPrimary = primary.filter((key) => listed.has(key));
  const listedOthers = others.filter((key) => listed.has(key));
  const unlisted = keys.length - listedPrimary.length - listedOthers.length;
  const summary =
    judged === null
      ? `${keys.length} ${keys.length === 1 ? 'failure' : 'failures'}`
      : fixCheckVerdict({
          own: judged.own,
          ownLeft: judged.left.length,
          others: judged.others,
          proven: judged.proven,
        }).join(', ');
  return [
    `${head}: ${summary}`,
    ...(listedPrimary.length > 0
      ? [
          classified ? 'New failures:' : 'Your failures that remain:',
          ...keyLines(listedPrimary, messages),
        ]
      : []),
    ...(listedOthers.length > 0
      ? [
          classified
            ? 'Pre-existing failures (also red at the run base):'
            : judged === null
              ? 'Failures:'
              : 'Other failures:',
          ...keyLines(listedOthers, messages),
        ]
      : []),
    ...(unlisted > 0 ? [`and ${unlisted} more`] : []),
    ...(!scoped ? ['Output tail:', output] : []),
  ].join('\n');
}
