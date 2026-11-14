import {
  FAILURE_KEY_PATH,
  fileFromFailureKey,
  isTestNodeKey,
} from '../../../core/review/fix/task.js';
import { realpathOrResolve } from '../../../core/trust/path-classification.js';
import { captureText, type ProcessOutputCapture } from '../../../lib/process/errors.js';
import { normalizeProjectRelativePath } from '../../../utils/path/patterns.js';
import { redactSecrets } from '../../../utils/redact/secrets.js';
import { truncateByChars } from '../../../utils/display-text/truncate.js';
import { failingTestKey, parseFailingTests, readNodeTap } from './test-failures.js';
import { scriptLines, nonEmptyLines } from './manager-output.js';

/**
 * The keys of a red command: its failing tests by name and its diagnostic lines, else the lines of
 * an output that lists only whole paths. A timeout, an incomplete capture or a red that names no
 * failure has one placeholder key, and `placeholder` says how it failed, since that key names no
 * failure; it quotes the script's first error line, else its only line, without the lines its
 * package manager printed around it.
 * Output lines that name no file, such as an `npm` script banner or a `make` error summary, are not
 * diagnostic lines.
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
  const output = relativeToDir(captureText(run.capture), dir);
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
  // pnpm prints its directory line as an absolute path, so the lines are read before they turn relative.
  const lines = scriptLines(run.capture.stdout, run.capture.stderr, {
    signaled: run.exitCode === undefined,
  });
  const own = nonEmptyLines(relativeToDir(lines.join('\n'), dir));
  const said = errorLine(own) ?? onlyLine(own);
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

/** An output line as a placeholder quotes it: without its indent or a TAP `#` prefix. */
function quotedLineText(line: string): string {
  return line.replace(/^\s*#?\s*/, '').trimEnd();
}

function quote(line: string): string {
  return truncateByChars(redactSecrets(quotedLineText(line)), ERROR_LINE_CHARS);
}

/** The first line that reports an error; never a stack frame. */
function errorLine(lines: readonly string[]): string | undefined {
  const line = lines.find((raw) => {
    const text = quotedLineText(raw);
    return ERROR_WORD.test(text) && !STACK_FRAME.test(text);
  });
  return line === undefined ? undefined : quote(line);
}

/** The one line a script printed: its failure message. */
function onlyLine(lines: readonly string[]): string | undefined {
  const [line, ...rest] = lines;
  return line === undefined || rest.length > 0 ? undefined : quote(line);
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

/** The heavy-dash rule that ends a Biome header line, after its location or its rule label. */
const BIOME_HEAVY_RULE = /━+$/;
/** The mark that starts a Biome note or warning message; an error message starts with × or ✖. */
const BIOME_NOTE_OR_WARNING = /^[iℹ!⚠] /;

/**
 * The failure keys of a command's output: diagnostic lines from their path token onward, else its
 * non-empty lines. `diagnostics` is false when the keys are those raw lines. Such a key can be
 * runner output (an `npm` script banner, a `make` error summary) that names no failure.
 * A check-mark row, a test node id without FAILED or ERROR, a warning-severity row and a line of
 * Node's TAP stream are not failure keys; the severity is read where the tool prints it, never
 * from the message text. A Biome header takes its severity from the message mark on the next
 * line: a note or a warning (`i`, `ℹ`, `!`, `⚠`) leaves the header out, and every other header
 * stays, such as one with an error (`×`, `✖`) or with no message line.
 */
export function extractFailureKeys(rawOutput: string): { keys: string[]; diagnostics: boolean } {
  const lines = readNodeTap(rawOutput)
    .rest.split('\n')
    .map((line) => line.trim())
    .map((line) => ({ text: line.replace(/\s*━+$/, ''), header: BIOME_HEAVY_RULE.test(line) }))
    .filter((line) => line.text.length > 0);
  const tokens: string[] = [];
  for (const [index, line] of lines.entries()) {
    const text = line.text;
    if (line.header && BIOME_NOTE_OR_WARNING.test(lines[index + 1]?.text ?? '')) continue;
    if (STACK_FRAME.test(text) || /^[✓√]|^.+:\d+: in \S+/.test(text) || /^warning\b/i.test(text))
      continue;
    const token = tokenOf(text);
    if (token === undefined) continue;
    if (isTestNodeKey(token) ? !/\b(?:FAILED|ERROR)\b/.test(text) : WARNING_SEVERITY.test(token)) {
      continue;
    }
    tokens.push(token);
  }
  return tokens.length > 0
    ? { keys: [...new Set(tokens)], diagnostics: true }
    : { keys: [...new Set(lines.map((line) => line.text))], diagnostics: false };
}
