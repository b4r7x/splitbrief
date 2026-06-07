export function uniqueSortedIds<T extends string>(ids: T[]): T[] {
  return [...new Set(ids)].sort();
}

export function uniquePush<T>(arr: T[], value: T): void {
  if (!arr.includes(value)) arr.push(value);
}

export function uniqueInOrder<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

export function countByValue<T, K extends string>(
  items: readonly T[],
  key: (item: T) => K,
): Partial<Record<K, number>> {
  const counts: Partial<Record<K, number>> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
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
