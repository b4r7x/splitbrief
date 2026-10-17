import { useRef, useState } from 'react';
import { useInput, type Key } from 'ink';
import { clampIndex, navigateIndex } from '../utils/indexing.js';

interface UseStaticSelectorOptions<T> {
  items: readonly T[];
  onSelect: (item: T, index: number) => void;
  onCancel?: (() => void) | undefined;
  isActive?: boolean | undefined;
  initialIndex?: number | undefined;
  isIndexActionable?: ((index: number) => boolean) | undefined;
  /** Row identity for lists re-derived from live state, so the cursor holds a row, not a slot. */
  keyOf?: ((item: T) => string) | undefined;
  shouldHandleInput?: ((input: string, key: Key) => boolean) | undefined;
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
  keyOf,
  shouldHandleInput,
}: UseStaticSelectorOptions<T>): UseStaticSelectorResult {
  const keyAt = (index: number): string | undefined => {
    const item = items[index];
    return keyOf === undefined || item === undefined ? undefined : keyOf(item);
  };
  const [selectedIndex, setSelectedIndex] = useState(clampIndex(initialIndex, items.length));
  const [anchorKey, setAnchorKey] = useState(() => keyAt(clampIndex(initialIndex, items.length)));
  // A keyed list is re-derived from live state and may drop the row under the cursor between
  // renders; the index alone would hand ENTER to whatever slid into that slot, so the cursor
  // follows its row and falls back to the first row once the row is gone.
  const anchored =
    anchorKey === undefined ? -1 : items.findIndex((item) => keyOf?.(item) === anchorKey);
  const effectiveIndex =
    anchorKey === undefined ? clampIndex(selectedIndex, items.length) : Math.max(anchored, 0);
  // Mirror current index synchronously: Ink may deliver UP+ENTER in the same render
  // generation, before React flushes setSelectedIndex from the prior key. The handler
  // also writes selectedRef on UP/DOWN so ENTER reads the latest index.
  const selectedRef = useRef(effectiveIndex);
  selectedRef.current = effectiveIndex;

  const moveTo = (next: number): void => {
    selectedRef.current = next;
    setSelectedIndex(next);
    setAnchorKey(keyAt(next));
  };

  useInput(
    (input, key) => {
      if (shouldHandleInput !== undefined && !shouldHandleInput(input, key)) return;
      // shift+↑/↓ scrolls the transcript; Ink reports it as an arrow to every active handler.
      if (key.shift && (key.upArrow || key.downArrow)) return;
      if (key.upArrow) {
        moveTo(navigateIndex('up', selectedRef.current, items.length));
        return;
      }
      if (key.downArrow) {
        moveTo(navigateIndex('down', selectedRef.current, items.length));
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
