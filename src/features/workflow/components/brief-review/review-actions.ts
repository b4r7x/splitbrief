export const REVIEW_ACTIONS = [
  { id: 'approve', command: 'approve' },
  { id: 'edit-file', command: 'edit-file' },
  { id: 'comment', command: null },
  { id: 'reject', command: 'reject' },
] as const;

type ReviewAction = (typeof REVIEW_ACTIONS)[number];
type ReviewActionId = ReviewAction['id'];
type SelectableReviewAction = Exclude<ReviewAction, { command: null }>;
export type SelectableReviewActionId = SelectableReviewAction['id'];
export type ReviewActionCommand = SelectableReviewAction['command'];
type ReviewActionDirection = 'previous' | 'next';

function hasCommand(action: ReviewAction): action is SelectableReviewAction {
  return action.command !== null;
}

export const REVIEW_ACTION_IDS = REVIEW_ACTIONS.map((action) => action.id);
const SELECTABLE_REVIEW_ACTIONS = REVIEW_ACTIONS.filter(hasCommand);
const SELECTABLE_REVIEW_ACTION_IDS = SELECTABLE_REVIEW_ACTIONS.map((action) => action.id);

export const DEFAULT_REVIEW_ACTION_ID: SelectableReviewActionId = 'approve';

export function nextReviewActionId(
  current: SelectableReviewActionId,
  direction: ReviewActionDirection,
): SelectableReviewActionId {
  const currentIndex = SELECTABLE_REVIEW_ACTION_IDS.indexOf(current);
  const nextIndex = Math.min(
    Math.max(currentIndex + (direction === 'next' ? 1 : -1), 0),
    SELECTABLE_REVIEW_ACTION_IDS.length - 1,
  );
  return SELECTABLE_REVIEW_ACTION_IDS[nextIndex] ?? current;
}

export function getReviewActionCommand(id: SelectableReviewActionId): ReviewActionCommand;
export function getReviewActionCommand(id: ReviewActionId): ReviewAction['command'];
export function getReviewActionCommand(id: ReviewActionId): ReviewAction['command'] {
  return REVIEW_ACTIONS.find((candidate) => candidate.id === id)?.command ?? null;
}
