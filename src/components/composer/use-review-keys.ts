import { useEffect } from 'react';
import type { Key } from 'ink';
import { isTextEntryInput } from '../../lib/terminal/text-entry.js';
import { reviewKeysStore } from '../../stores/ui/review-keys.js';
import type { InputMode } from '../../core/navigation/types.js';

interface UseReviewKeysParams {
  mode: InputMode;
  disabled: boolean | undefined;
  briefFocusHeld: boolean;
  draftEmpty: boolean;
}

interface ComposerReviewKeys {
  shouldHandleComposerInput: (input: string, key: Key) => boolean;
}

export function useReviewKeys({
  mode,
  disabled,
  briefFocusHeld,
  draftEmpty,
}: UseReviewKeysParams): ComposerReviewKeys {
  // A review gate's rows answer ⏎ only while the draft is empty; typed text is a correction, so
  // no letter settles the gate on its own — a sentence that opens with `q` must not end the run.
  const reviewActionKeysArmed = mode === 'review' && !disabled && !briefFocusHeld && draftEmpty;

  // The legend that advertises the rows renders in a sibling row, so the armed flag is
  // published rather than recomputed there: one condition, one writer, no drift.
  useEffect(() => {
    reviewKeysStore.setArmed(reviewActionKeysArmed);
    return () => reviewKeysStore.setArmed(false);
  }, [reviewActionKeysArmed]);

  const shouldHandleComposerInput = (input: string, key: Key): boolean =>
    !briefFocusHeld || (mode === 'review' && isTextEntryInput(input, key));

  return { shouldHandleComposerInput };
}
