import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';
import type { ValidationResult } from './result.js';
import { failingTestKey } from './test-failures.js';

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

export function stageFailureKeys(result: ValidationResult): string[] {
  if (result.timedOut === true) return [`${result.stage} timed out`];
  const keys =
    result.stage === 'test'
      ? (result.failingTests ?? []).map(failingTestKey)
      : extractFailureKeys(result.error ?? result.output ?? '');
  if (keys.length > 0) return keys;
  return [
    result.exitCode === undefined
      ? `${result.stage} failed without diagnostics`
      : `${result.stage} exited with code ${result.exitCode}`,
  ];
}
