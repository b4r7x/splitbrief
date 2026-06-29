import { useRef, useState } from 'react';
import { useInput } from 'ink';
import { clampIndex, navigateIndex } from '../utils/indexing.js';

interface UseStaticSelectorOptions<T> {
  items: readonly T[];
  onSelect: (item: T, index: number) => void;
  onCancel?: (() => void) | undefined;
  isActive?: boolean | undefined;
  initialIndex?: number | undefined;
  isIndexActionable?: ((index: number) => boolean) | undefined;
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
  isIndexActionable,
}: UseStaticSelectorOptions<T>): UseStaticSelectorResult {
  const [selectedIndex, setSelectedIndex] = useState(clampIndex(initialIndex, items.length));
  const effectiveIndex = clampIndex(selectedIndex, items.length);
  // Mirror current index synchronously: Ink may deliver UP+ENTER in the same render
  // generation, before React flushes setSelectedIndex from the prior key. The handler
  // also writes selectedRef on UP/DOWN so ENTER reads the latest index.
  const selectedRef = useRef(effectiveIndex);
  selectedRef.current = effectiveIndex;

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        const next = navigateIndex('up', selectedRef.current, items.length);
        selectedRef.current = next;
        setSelectedIndex(next);
        return;
      }
      if (key.downArrow) {
        const next = navigateIndex('down', selectedRef.current, items.length);
        selectedRef.current = next;
        setSelectedIndex(next);
        return;
      }
      if (key.return) {
        const index = selectedRef.current;
        if (isIndexActionable && !isIndexActionable(index)) return;
        const item = items[index];
        if (item !== undefined) onSelect(item, index);
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
