import { useRef } from 'react';
import { useInput } from 'ink';
import { useStaticSelector } from '../../../hooks/use-static-selector.js';
import { isItemIndexVisible } from '../../../components/pickers/scroll-window.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { slashHandoffPending } from '../slash-handoff.js';

/** The answer to ⏎ after a word, a paste or a letter that takes no row: a menu reads no typed words. */
export const UNREAD_WORDS_MESSAGE = 'Typed words choose no action. Choose one with ↑↓ and ⏎.';

// Typed words hold a character that is not white space and not a control character.
const TYPED_WORDS = /[^\s\p{Cc}]/u;

export function useInlineMenuKeys<T>({
  items,
  keyOf,
  letterOf,
  initialIndex,
  focused,
  listRows,
  onSelect,
  onTab,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  /** The letter key of a row, on a menu whose rows have one. */
  letterOf?: ((item: T) => string) | undefined;
  initialIndex?: number | undefined;
  focused: boolean;
  listRows: number;
  onSelect: (item: T) => void;
  onTab: () => void;
}): number {
  // Typed words, or a typed letter that takes no row, came after the last arrow: ⏎ asks for a
  // row. The mark goes when the keys leave the menu.
  const unread = useRef(false);
  if (!focused) unread.current = false;
  const { selectedIndex } = useStaticSelector<T>({
    items,
    initialIndex,
    isActive: focused,
    keyOf,
    shouldHandleInput: () => !slashHandoffPending(),
    isIndexActionable: () => listRows > 0,
    onSelect: (item) => {
      if (!unread.current) {
        onSelect(item);
        return;
      }
      unread.current = false;
      feedbackStore.setMessage(UNREAD_WORDS_MESSAGE);
    },
  });
  // A letter takes the row it names while that row is in view.
  const letterRow = (letter: string): T | undefined => {
    const itemIndex = items.findIndex((item) => letterOf?.(item) === letter);
    const inView =
      itemIndex >= 0 &&
      isItemIndexVisible({ items: [...items], selectedIndex, itemIndex, rowBudget: listRows });
    return inView ? items[itemIndex] : undefined;
  };
  // Escape belongs to the app's stop ladder; Tab only lets go of the keys.
  useInput(
    (input, key) => {
      if (key.tab) onTab();
      if ((key.upArrow || key.downArrow) && !key.shift) {
        unread.current = false;
        return;
      }
      const letter = input.length === 1 && !key.ctrl && !key.meta;
      if (letter && slashHandoffPending()) return;
      const row = letter ? letterRow(input.toLowerCase()) : undefined;
      if (row !== undefined) onSelect(row);
      else if ((letter || input.length > 1) && TYPED_WORDS.test(input)) unread.current = true;
    },
    { isActive: focused },
  );
  return selectedIndex;
}
