export interface SectionedItem<T> {
  item: T;
  sectionHeader: string | null;
}

export function toSectionedList<T>(
  items: T[],
  sectionKey: (item: T) => string,
): SectionedItem<T>[] {
  return items.map((item, i) => {
    const key = sectionKey(item);
    const prev = i > 0 ? items[i - 1] : undefined;
    const prevKey = prev !== undefined ? sectionKey(prev) : null;
    return { item, sectionHeader: key !== prevKey ? key : null };
  });
}
