import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';

const TOKEN_PATTERNS = [
  /[\w./\\-]+\.\w+::[\w.:[\]-]+/,
  /[\w./\\-]+\.\w+\(\d+,\d+\)/,
  /[\w./\\-]+\.\w+:\d+/,
];

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
