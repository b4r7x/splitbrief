export function uniqueIds<T extends string>(ids: T[]): T[] {
  return [...new Set(ids)].sort();
}

export function uniqueSorted(
  values: readonly string[],
  options?: { trim?: boolean; nonEmpty?: boolean },
): string[] {
  const trim = options?.trim ?? false;
  const nonEmpty = options?.nonEmpty ?? false;
  const seen = new Set<string>();
  for (const value of values) {
    const candidate = trim ? value.trim() : value;
    if (nonEmpty && candidate.length === 0) continue;
    seen.add(candidate);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function countBySeverity<T extends { severity: string }>(
  items: readonly T[],
): { error: number; warning: number; info: number } {
  let error = 0;
  let warning = 0;
  let info = 0;
  for (const item of items) {
    if (item.severity === 'error') error += 1;
    else if (item.severity === 'warning') warning += 1;
    else if (item.severity === 'info') info += 1;
  }
  return { error, warning, info };
}
