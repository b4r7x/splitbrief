import { useEffect } from 'react';
import { reviewKeysStore } from '../../stores/ui/review-keys.js';
import type { InputMode } from '../../core/navigation/types.js';

interface UseReviewKeysParams {
  mode: InputMode;
  disabled: boolean | undefined;
  draftEmpty: boolean;
}

export function useReviewKeys({ mode, disabled, draftEmpty }: UseReviewKeysParams): void {
  // A review gate's rows answer ⏎ only while the draft is empty; typed text is a correction, so
  // no letter settles the gate on its own — a sentence that opens with `q` must not end the run.
  // While the draft holds that correction, esc cancels it and hands the keys back to the rows.
  const commenting = mode === 'review' && !disabled && !draftEmpty;

  // The legend that advertises the rows renders in a sibling row, and the app's esc ladder spends
  // the first press on a comment, so the flag is published rather than recomputed there: one
  // condition, one writer, no drift.
  useEffect(() => {
    reviewKeysStore.setCommenting(commenting);
    return () => reviewKeysStore.setCommenting(false);
  }, [commenting]);
}
