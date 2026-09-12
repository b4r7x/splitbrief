const SELECTABLE_REVIEW_ACTION_IDS = ['approve', 'edit-file', 'reject'] as const;

export type SelectableReviewActionId = (typeof SELECTABLE_REVIEW_ACTION_IDS)[number];

export const DEFAULT_REVIEW_ACTION_ID: SelectableReviewActionId = 'approve';

/** The cycle clamps at both ends: a wrap would move the operator off the action they were on. */
export function nextReviewActionId(
  current: SelectableReviewActionId,
  direction: 'previous' | 'next',
): SelectableReviewActionId {
  const currentIndex = SELECTABLE_REVIEW_ACTION_IDS.indexOf(current);
  const nextIndex = Math.min(
    Math.max(currentIndex + (direction === 'next' ? 1 : -1), 0),
    SELECTABLE_REVIEW_ACTION_IDS.length - 1,
  );
  return SELECTABLE_REVIEW_ACTION_IDS[nextIndex] ?? current;
}
