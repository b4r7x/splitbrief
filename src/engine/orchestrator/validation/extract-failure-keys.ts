import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';
import { failingTestKey, parseFailingTests } from './test-failures.js';

/**
 * The keys of a red command. Its failing tests by name, else its diagnostic lines, identify the
 * failure; a timeout or a red with neither has one placeholder key, and `placeholder` says how it
 * failed, since that key names no failure. Output lines that name no file, such as an `npm`
 * script banner or a `make` error summary, are not diagnostic lines.
 */
export type FailureKeys = { keys: string[]; placeholder?: string | undefined };

export function failureKeys(
  text: string,
  run: { timedOut?: true | undefined; exitCode?: number | undefined },
  dir: string,
): FailureKeys {
  if (run.timedOut === true) return { keys: ['timed out'], placeholder: 'timed out' };
  const output = text.replaceAll(`${dir}/`, '');
  const tests = parseFailingTests(output);
  if (tests.length > 0) return { keys: [...new Set(tests.map(failingTestKey))] };
  const extracted = extractFailureKeys(output);
  if (extracted.diagnostics) return { keys: extracted.keys };
  if (run.exitCode === undefined) {
    return { keys: ['failed without diagnostics'], placeholder: 'failed without diagnostics' };
  }
  const key = `exited with code ${run.exitCode}`;
  return { keys: [key], placeholder: `${key} without diagnostics` };
}

const PATH = String.raw`[\w./\\-]+\.[A-Za-z]\w*`;
const SUFFIXES = [String.raw`::[\w.:[\]-]+`, String.raw`\(\d+,\d+\)`, String.raw`:\d+`];

const TOKEN_PATTERNS = SUFFIXES.map((suffix) => new RegExp(`${PATH}${suffix}`));

const KEY_FILE = new RegExp(`^(${PATH})(?:${SUFFIXES.join('|')})?$`);

function tokenOf(line: string): string | undefined {
  for (const pattern of TOKEN_PATTERNS) {
    const token = pattern.exec(line)?.[0];
    if (token !== undefined) return normalizeProjectRelativePath(token);
  }
  return undefined;
}

/**
 * The failure keys of a command's output: the path tokens of its diagnostic lines, else its
 * non-empty lines. `diagnostics` is false when the keys are those raw lines. Such a key can be
 * runner output (an `npm` script banner, a `make` error summary) that names no failure.
 */
export function extractFailureKeys(rawOutput: string): { keys: string[]; diagnostics: boolean } {
  const lines = rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tokens: string[] = [];
  for (const line of lines) {
    const token = tokenOf(line);
    if (token !== undefined) tokens.push(token);
  }
  return tokens.length > 0
    ? { keys: [...new Set(tokens)], diagnostics: true }
    : { keys: [...new Set(lines)], diagnostics: false };
}

/**
 * The file a failure key names: the path token that leads a diagnostic key, or an output line that
 * is one whole path. Null when the key names no file, such as an `npm` script banner
 * (`> tsx scripts/x.ts`), a command line or a `make` error summary.
 */
export function fileFromFailureKey(key: string): string | null {
  const file = KEY_FILE.exec(key)?.[1];
  return file === undefined ? null : normalizeProjectRelativePath(file);
}
