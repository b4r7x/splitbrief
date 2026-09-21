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

// A test runner's tail carries a fresh timestamp and duration on every run, so
// keying pathless lines by their text makes two runs of one red suite compare
// unequal. Pathless lines are the fallback for output that named no path at all.
export function extractFailureKeys(rawOutput: string): string[] {
  const lines = rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tokens: string[] = [];
  for (const line of lines) {
    const token = tokenOf(line);
    if (token !== undefined) tokens.push(token);
  }
  return [...new Set(tokens.length > 0 ? tokens : lines)];
}
