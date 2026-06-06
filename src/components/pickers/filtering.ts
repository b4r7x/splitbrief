export type FilterableItem = { id: string; displayName: string };

export function filterByFields<T>(item: T, query: string, fields: (keyof T)[]): boolean {
  if (query.length === 0) return true;
  const lower = query.toLowerCase();
  for (const f of fields) {
    if (String(item[f]).toLowerCase().includes(lower)) return true;
  }
  return false;
}
