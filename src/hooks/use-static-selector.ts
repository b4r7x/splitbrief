import { useState } from 'react';
import { useInput } from 'ink';
import { clampIndex, navigateIndex } from './navigate-index.js';

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
  const [selectedIndex, setSelectedIndex] = useState(clampIndex(initialIndex, items.length));
  const effectiveIndex = clampIndex(selectedIndex, items.length);

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        setSelectedIndex((i) => navigateIndex('up', i, items.length));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => navigateIndex('down', i, items.length));
        return;
      }
      if (key.return) {
        const item = items[effectiveIndex];
        if (item !== undefined) onSelect(item, effectiveIndex);
        return;
      }
      if (key.escape) {
        onCancel?.();
      }
    },
    { isActive },
  );

  return { selectedIndex: effectiveIndex };
}
