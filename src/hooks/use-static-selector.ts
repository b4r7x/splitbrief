import { useInput, type Key } from 'ink';
import { clampIndex, navigateIndex } from '../utils/indexing.js';
import { useKeyState } from './use-key-state.js';

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
  const [selectedIndex, setSelectedIndex, latestIndex] = useKeyState(
    clampIndex(initialIndex, items.length),
  );
  const [anchorKey, setAnchorKey, latestAnchor] = useKeyState(
    keyAt(clampIndex(initialIndex, items.length)),
  );
  // A keyed list is re-derived from live state and may drop the row under the cursor between
  // renders; the index alone would hand ENTER to whatever slid into that slot, so the cursor
  // follows its row and falls back to the first row once the row is gone.
  const cursorAt = (index: number, anchor: string | undefined): number =>
    anchor === undefined
      ? clampIndex(index, items.length)
      : Math.max(
          items.findIndex((item) => keyOf?.(item) === anchor),
          0,
        );
  const effectiveIndex = cursorAt(selectedIndex, anchorKey);
  const latestCursor = (): number => cursorAt(latestIndex(), latestAnchor());

  const moveTo = (next: number): void => {
    setSelectedIndex(next);
    setAnchorKey(keyAt(next));
  };

  useInput(
    (input, key) => {
      if (shouldHandleInput !== undefined && !shouldHandleInput(input, key)) return;
      // shift+↑/↓ scrolls the transcript; Ink reports it as an arrow to every active handler.
      if (key.shift && (key.upArrow || key.downArrow)) return;
      if (key.upArrow) {
        moveTo(navigateIndex('up', latestCursor(), items.length));
        return;
      }
      if (key.downArrow) {
        moveTo(navigateIndex('down', latestCursor(), items.length));
        return;
      }
      if (key.return) {
        const index = latestCursor();
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
