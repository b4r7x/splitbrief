import type { Phase } from '../../../core/schemas/enums.js';
import type { PlannerCall } from '../../../core/schemas/run-step.js';
import { assertNever } from '../../../utils/type-guards.js';

// One vocabulary for what the run is doing right now: the byline says it as a heading, the build
// block says it inside a sentence. Both read it here. The plan stage holds two planner calls, so
// its verb names the call the engine said it is on. A gate that rewrites its document from a
// change request names that call with the verb it has outside the gate.
export function activeVerb(
  phase: Phase,
  reviewerLabel: string | null,
  plannerCall: PlannerCall | null,
): string {
  switch (phase) {
    case 'researching':
      return 'Researching…';
    case 'specifying':
      return 'Specifying…';
    case 'reviewing-spec':
      if (plannerCall !== null) return activeVerb('specifying', reviewerLabel, plannerCall);
      return 'Reviewing spec…';
    case 'clarifying':
      return 'Clarifying…';
    case 'constitution-check':
      return 'Checking constitution…';
    case 'planning':
      if (plannerCall === 'plan') return 'Writing the plan…';
      if (plannerCall === 'tasks') return 'Compiling briefs…';
      return 'Planning…';
    case 'reviewing-plan':
      if (plannerCall !== null) return activeVerb('planning', reviewerLabel, plannerCall);
      return 'Reviewing plan…';
    case 'reviewing-briefs':
      if (plannerCall !== null) return activeVerb('planning', reviewerLabel, plannerCall);
      return 'Reviewing briefs…';
    case 'analyzing':
      return 'Analyzing…';
    case 'implementing':
      return 'Implementing…';
    case 'validating-task':
      return 'Validating…';
    case 'escalating':
      return 'Escalating…';
    case 'final-review':
      return reviewerLabel === null ? 'Review…' : `Review… ${reviewerLabel}`;
    case 'idle':
    case 'complete':
      return '';
    default:
      return assertNever(phase);
  }
}

/** The same verb inside a sentence: no capital, no ellipsis, no reviewer name. */
export function inlineActiveVerb(phase: Phase): string {
  return activeVerb(phase, null, null).replace('…', '').toLowerCase();
}
