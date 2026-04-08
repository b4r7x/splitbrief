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
    const prevKey = i > 0 ? sectionKey(items[i - 1]) : null;
    return { item, sectionHeader: key !== prevKey ? key : null };
  });
}
