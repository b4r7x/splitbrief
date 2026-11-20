import type { StepRef, StepCut } from '../../../core/schemas/run-step.js';
import { assertNever } from '../../../utils/type-guards.js';

export const CONTINUE_KEY_HINT = '⏎ to continue';

/**
 * A step in the words the rest of the screen uses for it: a brief by id, every planner call or
 * gate as the plan, the one stage the rail shows for them, and Apply by the stage it names.
 */
export function stepWord(step: StepRef): string {
  switch (step.kind) {
    case 'planner':
    case 'gate':
      return 'the plan';
    case 'brief':
      return step.taskId;
    case 'review':
      return 'the review';
    case 'apply':
      return 'Apply';
    default:
      return assertNever(step);
  }
}

/**
 * Where a stop left the run, in the words the transcript row and every byline share: before the
 * brief a stop between briefs holds back, else at the step it stopped on.
 */
export function stopPoint(step: StepRef, at: StepCut | undefined): string {
  if (at === 'boundary') {
    if (step.kind === 'brief') return `before ${step.taskId}`;
    if (step.kind === 'review') return 'before the review';
  }
  return `at ${stepWord(step)}`;
}
