import { useInput } from 'ink';
import { useStaticSelector } from '../../../hooks/use-static-selector.js';
import { slashHandoffPending } from '../slash-handoff.js';

export function useInlineMenuKeys<T>({
  items,
  keyOf,
  initialIndex,
  focused,
  listRows,
  onSelect,
  onTab,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  initialIndex?: number | undefined;
  focused: boolean;
  listRows: number;
  onSelect: (item: T) => void;
  onTab: () => void;
}): number {
  const { selectedIndex } = useStaticSelector<T>({
    items,
    initialIndex,
    isActive: focused,
    keyOf,
    shouldHandleInput: () => !slashHandoffPending(),
    isIndexActionable: () => listRows > 0,
    onSelect,
  });
  // Escape belongs to the app's stop ladder; Tab only lets go of the keys.
  useInput(
    (_input, key) => {
      if (key.tab) onTab();
    },
    { isActive: focused },
  );
  return selectedIndex;
}
