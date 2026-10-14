import {
  FAILURE_KEY_PATH,
  fileFromFailureKey,
  isTestNodeKey,
} from '../../../core/review/fix-task.js';
import { realpathOrResolve } from '../../../core/trust/path-classification.js';
import type { ProcessOutputCapture } from '../../../lib/process/errors.js';
import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';
import { redactSecrets } from '../../../utils/redact.js';
import { truncateByChars } from '../../../utils/truncate.js';
import { failingTestKey, parseFailingTests, readNodeTap } from './test-failures.js';

/**
 * The keys of a red command: its failing tests by name and its diagnostic lines, else the lines of
 * an output that lists only whole paths. A timeout, an incomplete capture or a red that names no
 * failure has one placeholder key, and `placeholder` says how it failed, since that key names no
 * failure; it quotes the output's first error line when there is one. Output lines that name no
 * file, such as an `npm` script banner or a `make` error summary, are not diagnostic lines.
 * `messages` holds, per failing test key, the first line the runner printed under it (its
 * assertion message), read from the whole capture; a diagnostic key is its own line and has no
 * entry.
 */
export type FailureKeys = {
  keys: string[];
  placeholder?: string | undefined;
  messages?: ReadonlyMap<string, string> | undefined;
};

export function failureKeys(
  run: {
    capture: ProcessOutputCapture;
    timedOut?: true | undefined;
    exitCode?: number | undefined;
  },
  dir: string,
): FailureKeys {
  if (run.timedOut === true) return { keys: ['timed out'], placeholder: 'timed out' };
  if (!run.capture.complete) {
    return {
      keys: ['output over the capture limit'],
      placeholder: 'output over the capture limit',
    };
  }
  const output = relativeToDir(run.capture.text, dir);
  const tests = parseFailingTests(output);
  const extracted = extractFailureKeys(output);
  const keys = [
    ...new Set([...tests.map(failingTestKey), ...(extracted.diagnostics ? extracted.keys : [])]),
  ];
  const messages = new Map<string, string>();
  for (const test of tests) {
    const key = failingTestKey(test);
    if (test.message !== '' && !STACK_FRAME.test(test.message) && !messages.has(key)) {
      messages.set(key, test.message);
    }
  }
  if (keys.length > 0) return { keys, ...(messages.size > 0 && { messages }) };
  if (
    extracted.keys.length > 0 &&
    extracted.keys.every((line) => fileFromFailureKey(line) === normalizeProjectRelativePath(line))
  ) {
    return { keys: [...new Set(extracted.keys.map(normalizeProjectRelativePath))] };
  }
  const said = errorLine(output);
  if (run.exitCode === undefined) {
    return {
      keys: ['failed without diagnostics'],
      placeholder: said === undefined ? 'failed without diagnostics' : `failed: ${said}`,
    };
  }
  const key = `exited with code ${run.exitCode}`;
  return {
    keys: [key],
    placeholder: said === undefined ? `${key} without diagnostics` : `${key}: ${said}`,
  };
}

/**
 * The output with the paths under `dir` relative to it, under `dir` as given and under its real
 * path, which Node's test runner prints. The longer root goes first, so neither cuts the other.
 */
export function relativeToDir(output: string, dir: string): string {
  return [dir, realpathOrResolve(dir)]
    .sort((a, b) => b.length - a.length)
    .reduce((text, root) => text.replaceAll(`${root}/`, ''), output);
}

const ERROR_WORD = /\b\w*(?:error|exception)\b|\b(?:fatal|panic)\b/i;
const ERROR_LINE_CHARS = 200;

/** The first output line that reports an error, without a TAP `#` prefix; never a stack frame. */
function errorLine(output: string): string | undefined {
  for (const raw of output.split('\n')) {
    const line = raw.replace(/^\s*#?\s*/, '').trimEnd();
    if (ERROR_WORD.test(line) && !STACK_FRAME.test(line)) {
      return truncateByChars(redactSecrets(line), ERROR_LINE_CHARS);
    }
  }
  return undefined;
}

/** A stack frame row: `at fn (file:1:2)`, vitest's `❯ file:1:2`, jest's `→ file:1:2`. */
const STACK_FRAME = /^(?:at |❯ |→ )/;

const TOKEN_PATTERNS = [
  String.raw`::[\w.:[\]-]+`,
  String.raw`\(\d+,\d+\)`,
  String.raw`:\d+(?::\d+)?`,
].map((suffix) => new RegExp(`${FAILURE_KEY_PATH}${suffix}`));

/** A warning severity right after the position: `: warning:`, `: DeprecationWarning:`. */
const WARNING_SEVERITY = /^[^\s(:]+(?:\(\d+,\d+\)|:\d+(?::\d+)?)\s*:?\s*\w*warning\b/i;

function tokenOf(line: string): string | undefined {
  for (const pattern of TOKEN_PATTERNS) {
    const match = pattern.exec(line);
    if (match !== null) {
      const token = normalizeProjectRelativePath(match[0]);
      return isTestNodeKey(token) ? token : `${token}${line.slice(match.index + match[0].length)}`;
    }
  }
  return undefined;
}

/**
 * The failure keys of a command's output: diagnostic lines from their path token onward, else its
 * non-empty lines. `diagnostics` is false when the keys are those raw lines. Such a key can be
 * runner output (an `npm` script banner, a `make` error summary) that names no failure.
 * A check-mark row, a test node id without FAILED or ERROR, a warning-severity row and a line of
 * Node's TAP stream are not failure keys; the severity is read where the tool prints it, never
 * from the message text.
 */
export function extractFailureKeys(rawOutput: string): { keys: string[]; diagnostics: boolean } {
  const lines = readNodeTap(rawOutput)
    .rest.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tokens: string[] = [];
  for (const line of lines) {
    if (STACK_FRAME.test(line) || /^[✓√]|^.+:\d+: in \S+/.test(line) || /^warning\b/i.test(line))
      continue;
    const token = tokenOf(line);
    if (token === undefined) continue;
    if (isTestNodeKey(token) ? !/\b(?:FAILED|ERROR)\b/.test(line) : WARNING_SEVERITY.test(token)) {
      continue;
    }
    tokens.push(token);
  }
  return tokens.length > 0
    ? { keys: [...new Set(tokens)], diagnostics: true }
    : { keys: [...new Set(lines)], diagnostics: false };
}
