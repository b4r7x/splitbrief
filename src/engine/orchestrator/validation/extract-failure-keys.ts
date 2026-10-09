import {
  FAILURE_KEY_PATH,
  fileFromFailureKey,
  isTestNodeKey,
} from '../../../core/review/fix-task.js';
import type { ProcessOutputCapture } from '../../../lib/process/errors.js';
import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';
import { failingTestKey, parseFailingTests } from './test-failures.js';

/**
 * The keys of a red command: its failing tests by name and its diagnostic lines, else the lines of
 * an output that lists only whole paths. A timeout, an incomplete capture or a red that names no
 * failure has one placeholder key, and `placeholder` says how it failed, since that key names no
 * failure. Output lines that name no file, such as an `npm` script banner or a `make` error
 * summary, are not diagnostic lines.
 */
export type FailureKeys = { keys: string[]; placeholder?: string | undefined };

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
  const output = run.capture.text.replaceAll(`${dir}/`, '');
  const tests = parseFailingTests(output);
  const extracted = extractFailureKeys(output);
  const keys = [
    ...new Set([...tests.map(failingTestKey), ...(extracted.diagnostics ? extracted.keys : [])]),
  ];
  if (keys.length > 0) return { keys };
  if (
    extracted.keys.length > 0 &&
    extracted.keys.every((line) => fileFromFailureKey(line) === normalizeProjectRelativePath(line))
  ) {
    return { keys: [...new Set(extracted.keys.map(normalizeProjectRelativePath))] };
  }
  if (run.exitCode === undefined) {
    return { keys: ['failed without diagnostics'], placeholder: 'failed without diagnostics' };
  }
  const key = `exited with code ${run.exitCode}`;
  return { keys: [key], placeholder: `${key} without diagnostics` };
}

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
 * A check-mark row, a test node id without FAILED or ERROR, and a warning-severity row are not
 * failure keys; the severity is read where the tool prints it, never from the message text.
 */
export function extractFailureKeys(rawOutput: string): { keys: string[]; diagnostics: boolean } {
  const lines = rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tokens: string[] = [];
  for (const line of lines) {
    if (/^(?:at |❯ |→ |[✓√])|^.+:\d+: in \S+/.test(line) || /^warning\b/i.test(line)) continue;
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
