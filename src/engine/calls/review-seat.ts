import type { Phase } from '../../core/schemas/enums.js';
import type { RunnerCallContext } from './types.js';

// Planning-time review calls (estimate review, regen, speckit) log `role: 'review'` while the
// planner runs, so they stay on PLAN. The review seat's own calls are the final review and, in
// the build phases, the scheduled task review, the review-checks call and the consult on a fix
// task's retry ladder.
const REVIEW_SEAT_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'final-review',
  'implementing',
  'validating-task',
  'escalating',
]);

export function isReviewSeatCall(
  input: Readonly<{ role: RunnerCallContext['role']; phase: Phase | undefined }>,
): boolean {
  return (
    input.role === 'review' && input.phase !== undefined && REVIEW_SEAT_PHASES.has(input.phase)
  );
}
