import type { Phase } from '../../core/schemas/enums.js';
import type { RunnerCallContext } from './types.js';

// Planning-time review calls (estimate review, regen, speckit) log `role: 'review'` while the
// planner runs; only the review seat's own call runs in `final-review`.
export function isReviewSeatCall(
  input: Readonly<{ role: RunnerCallContext['role']; phase: Phase | undefined }>,
): boolean {
  return input.role === 'review' && input.phase === 'final-review';
}
