function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function extractNamedChangedFiles(
  output: string,
  changedFiles: readonly string[],
): readonly string[] {
  if (changedFiles.length === 0 || output.length === 0) return [];
  const normalizedOutput = output.replaceAll('\\', '/');
  const normalized = changedFiles.map(normalizePath);
  const basenameCounts = new Map<string, number>();
  for (const file of normalized) {
    const base = basenameOf(file);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }
  return changedFiles.filter((file) => {
    const path = normalizePath(file);
    if (normalizedOutput.includes(path)) return true;
    const base = basenameOf(path);
    return basenameCounts.get(base) === 1 && normalizedOutput.includes(base);
  });
}
