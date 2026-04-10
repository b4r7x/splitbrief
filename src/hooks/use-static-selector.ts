import { useState } from 'react';
import { useInput } from 'ink';

interface UseStaticSelectorOptions<T> {
  items: readonly T[];
  onSelect: (item: T, index: number) => void;
  onCancel?: (() => void) | undefined;
  isActive?: boolean | undefined;
  initialIndex?: number | undefined;
}

interface UseStaticSelectorResult {
  selectedIndex: number;
}

export function useStaticSelector<T>({
  items,
  onSelect,
  onCancel,
  isActive = true,
  initialIndex = 0,
}: UseStaticSelectorOptions<T>): UseStaticSelectorResult {
  const [selectedIndex, setSelectedIndex] = useState(Math.max(0, initialIndex));

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        setSelectedIndex((i) => (i > 0 ? i - 1 : items.length - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => (i < items.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        const item = items[selectedIndex];
        if (item !== undefined) onSelect(item, selectedIndex);
        return;
      }
      if (key.escape) {
        onCancel?.();
      }
    },
    { isActive },
  );

  return { selectedIndex };
}
