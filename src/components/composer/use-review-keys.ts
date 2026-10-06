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
  const reviewActionKeysArmed = mode === 'review' && !disabled && draftEmpty;

  // The legend that advertises the rows renders in a sibling row, so the armed flag is
  // published rather than recomputed there: one condition, one writer, no drift.
  useEffect(() => {
    reviewKeysStore.setArmed(reviewActionKeysArmed);
    return () => reviewKeysStore.setArmed(false);
  }, [reviewActionKeysArmed]);
}
