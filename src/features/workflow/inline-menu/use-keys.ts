import { useRef } from 'react';
import { useInput } from 'ink';
import { useStaticSelector } from '../../../hooks/use-static-selector.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { slashHandoffPending } from '../slash-handoff.js';

/** The answer to ⏎ after a word or a paste: an inline menu reads no typed words. */
export const UNREAD_WORDS_MESSAGE = 'Typed words choose no action. Choose one with ↑↓ and ⏎.';

// Typed words hold a character that is not white space and not a control character.
const TYPED_WORDS = /[^\s\p{Cc}]/u;

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
  // A text key of more than one character with typed words came after the last arrow: ⏎ asks
  // for a row. The mark goes when the keys leave the menu.
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
  // Escape belongs to the app's stop ladder; Tab only lets go of the keys.
  useInput(
    (input, key) => {
      if (key.tab) onTab();
      if ((key.upArrow || key.downArrow) && !key.shift) unread.current = false;
      else if (input.length > 1 && TYPED_WORDS.test(input)) unread.current = true;
    },
    { isActive: focused },
  );
  return selectedIndex;
}
