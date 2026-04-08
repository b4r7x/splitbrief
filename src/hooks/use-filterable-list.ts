import { useState } from 'react';
import { useInput } from 'ink';

interface UseFilterableListOptions<T> {
  items: T[];
  filterFn: (item: T, query: string) => boolean;
  onSelect: (item: T) => void;
  onClose?: () => void;
  isActive?: boolean;
  shouldAppendChar?: (input: string) => boolean;
  initialIndex?: number;
}

export interface UseFilterableListResult<T> {
  filter: string;
  setFilter: (f: string) => void;
  filtered: T[];
  selectedIndex: number;
  setSelectedIndex: (i: number) => void;
}

export function useFilterableList<T>({
  items,
  filterFn,
  onSelect,
  onClose,
  isActive = true,
  shouldAppendChar,
  initialIndex,
}: UseFilterableListOptions<T>): UseFilterableListResult<T> {
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(initialIndex ?? 0);

  const filtered = filter ? items.filter((item) => filterFn(item, filter)) : items;

  const effectiveIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  useInput(
    (input, key) => {
      if (key.escape) {
        onClose?.();
        return;
      }
      if (key.return && filtered.length > 0) {
        onSelect(filtered[effectiveIndex]);
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
        return;
      }
      if (key.backspace || key.delete) {
        setFilter((prev) => prev.slice(0, -1));
        setSelectedIndex(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        if (shouldAppendChar && !shouldAppendChar(input)) return;
        setFilter((prev) => prev + input);
        setSelectedIndex(0);
      }
    },
    { isActive },
  );

  return { filter, setFilter, filtered, selectedIndex: effectiveIndex, setSelectedIndex };
}
