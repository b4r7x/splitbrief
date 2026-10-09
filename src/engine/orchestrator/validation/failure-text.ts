import {
  fixCheckVerdict,
  judgeFixCheck,
  pairFailureKeys,
  type FixCheckKeys,
} from '../../../core/review/fix-task.js';
import { redactSecrets } from '../../../utils/redact.js';
import { truncateByChars } from '../../../utils/truncate.js';
import type { CheckRunResult } from './run-checks.js';

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

/**
 * The text a check that did not pass hands the implementer, the consult and the reviewer. A red
 * with failure keys leads with them, each failing test with its assertion message, before the
 * output tail, so a tail of runner noise still names the failure. With `carried`, the keys a fix
 * task answers, it says which of them remain and lists those first. A red with a placeholder key
 * and every other status keep the output as it is.
 */
export function checkFailureText(run: CheckRunResult, carried?: FixCheckKeys): string {
  const head = `check ${run.checkId} did not pass (${run.status})`;
  if (run.status !== 'fail' || run.failure.placeholder !== undefined) {
    return `${head}: ${run.output}`;
  }
  const { keys } = run.failure;
  const messages = run.failure.messages ?? new Map<string, string>();
  const judged = carried === undefined ? null : judgeFixCheck(carried, run.failure);
  // The task's own keys that remain, as this run prints them: a diagnostic may have moved lines.
  const { remaining } = pairFailureKeys(judged?.left ?? [], keys);
  const own = keys.filter((_key, index) => !remaining.has(index));
  const others = keys.filter((_key, index) => remaining.has(index));
  const listedOwn = own.slice(0, LISTED_FAILURE_KEYS);
  const listedOthers = others.slice(0, LISTED_FAILURE_KEYS - listedOwn.length);
  const unlisted = keys.length - listedOwn.length - listedOthers.length;
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
    ...(listedOwn.length > 0
      ? ['Your failures that remain:', ...keyLines(listedOwn, messages)]
      : []),
    ...(listedOthers.length > 0
      ? [judged === null ? 'Failures:' : 'Other failures:', ...keyLines(listedOthers, messages)]
      : []),
    ...(unlisted > 0 ? [`and ${unlisted} more`] : []),
    'Output tail:',
    run.output,
  ].join('\n');
}
