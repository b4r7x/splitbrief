import { useEffect } from 'react';
import { reviewKeysStore } from '../../stores/ui/review-keys.js';
import type { InputMode } from '../../core/navigation/types.js';

interface UseReviewKeysParams {
  mode: InputMode;
  disabled: boolean | undefined;
  draftEmpty: boolean;
}

export function useReviewKeys({ mode, disabled, draftEmpty }: UseReviewKeysParams): boolean {
  const requested = reviewKeysStore.use((state) => state.requested);
  // A review gate's rows answer ⏎ only while the draft is empty; typed text is a correction, so
  // no letter settles the gate on its own — a sentence that opens with `q` must not end the run.
  // Request changes opens that correction before a word is typed. While it is open, esc cancels it
  // and hands the keys back to the rows.
  const commenting = mode === 'review' && !disabled && (requested || !draftEmpty);

  // The legend that advertises the rows renders in a sibling row, and the app's esc ladder spends
  // the first press on a comment, so the flag is published rather than recomputed there: one
  // condition, one writer, no drift.
  useEffect(() => {
    reviewKeysStore.setCommenting(commenting);
    return () => reviewKeysStore.setCommenting(false);
  }, [commenting]);

  // A change request belongs to the gate it was made at: it ends when the review does.
  useEffect(() => {
    if (mode !== 'review') return;
    return () => reviewKeysStore.endComment();
  }, [mode]);

  return commenting;
}
