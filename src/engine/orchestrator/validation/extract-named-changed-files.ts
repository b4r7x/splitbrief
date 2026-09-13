import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';

const FILENAME_CHAR = /[\w.-]/;

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function isPathBoundary(char: string | undefined): boolean {
  return char === undefined || !FILENAME_CHAR.test(char);
}

function namesPath(output: string, candidate: string): boolean {
  for (let at = output.indexOf(candidate); at !== -1; at = output.indexOf(candidate, at + 1)) {
    const end = at + candidate.length;
    if (isPathBoundary(output[at - 1]) && isPathBoundary(output[end])) return true;
  }
  return false;
}

export function extractNamedChangedFiles(
  output: string,
  changedFiles: readonly string[],
): readonly string[] {
  if (changedFiles.length === 0 || output.length === 0) return [];
  const normalizedOutput = output.replaceAll('\\', '/');
  const normalized = changedFiles.map(normalizeProjectRelativePath);
  const basenameCounts = new Map<string, number>();
  for (const file of normalized) {
    const base = basenameOf(file);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }
  return changedFiles.filter((file) => {
    const path = normalizeProjectRelativePath(file);
    if (namesPath(normalizedOutput, path)) return true;
    const base = basenameOf(path);
    return basenameCounts.get(base) === 1 && namesPath(normalizedOutput, base);
  });
}
