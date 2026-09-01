import { useEffect, useRef } from 'react';
import { useInput, type Key } from 'ink';
import { REVIEW_COMMENT_DRAFT, resolveReviewActionKey } from '../../core/keybindings/review.js';
import { isTextEntryInput, isUnmodifiedYInput } from '../../lib/terminal/text-entry.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../lib/terminal/typeahead-grace.js';
import { reviewKeysStore } from '../../stores/ui/review-keys.js';
import type { InputMode } from '../../core/navigation/types.js';

interface UseReviewKeysParams {
  mode: InputMode;
  disabled: boolean | undefined;
  briefFocusHeld: boolean;
  draftEmpty: boolean;
  reviewYankActive: boolean;
  onDraft: (text: string) => void;
  onCommand: (command: string) => void;
}

interface ComposerReviewKeys {
  shouldHandleComposerInput: (input: string, key: Key) => boolean;
}

export function useReviewKeys({
  mode,
  disabled,
  briefFocusHeld,
  draftEmpty,
  reviewYankActive,
  onDraft,
  onCommand,
}: UseReviewKeysParams): ComposerReviewKeys {
  // The workflow screen remounts the composer when a review gate opens, so mount time
  // is gate time — keystrokes buffered before the gate cannot settle it.
  const graceUntilRef = useRef(Date.now() + PROMPT_TYPEAHEAD_GRACE_MS);

  // A review gate settles on one key only while the draft is empty; the moment the
  // user types anything the same letters go back to being text.
  const reviewActionKeysArmed = mode === 'review' && !disabled && !briefFocusHeld && draftEmpty;

  // The legend that advertises these keys renders in a sibling row, so the armed flag is
  // published rather than recomputed there: one condition, one writer, no drift.
  useEffect(() => {
    reviewKeysStore.setArmed(reviewActionKeysArmed);
    return () => reviewKeysStore.setArmed(false);
  }, [reviewActionKeysArmed]);

  const reviewActionKey = (input: string, key: Key) =>
    reviewActionKeysArmed && Date.now() >= graceUntilRef.current
      ? resolveReviewActionKey(input, key)
      : null;

  useInput(
    (input, key) => {
      const command = reviewActionKey(input, key);
      if (command === null) return;
      if (command === 'comment') {
        onDraft(REVIEW_COMMENT_DRAFT);
        return;
      }
      onCommand(command);
    },
    { isActive: reviewActionKeysArmed },
  );

  const shouldHandleComposerInput = (input: string, key: Key): boolean =>
    reviewActionKey(input, key) === null &&
    (!briefFocusHeld ||
      (mode === 'review' &&
        (!reviewYankActive || !isUnmodifiedYInput(input, key)) &&
        isTextEntryInput(input, key)));

  return { shouldHandleComposerInput };
}
