import type { Phase } from './schemas/enums.js';
import type { WorkflowState } from './schemas/workflow.js';

const IMPLEMENTER_PHASES: ReadonlySet<Phase> = new Set([
  'implementing',
  'validating-task',
  'escalating',
]);

export function phaseRole(phase: Phase): 'planner' | 'implementer' {
  return IMPLEMENTER_PHASES.has(phase) ? 'implementer' : 'planner';
}

export const CANCELLABLE_PHASES: ReadonlySet<Phase> = new Set([
  'researching',
  'specifying',
  'reviewing-spec',
  'clarifying',
  'constitution-check',
  'planning',
  'reviewing-plan',
  'reviewing-briefs',
  'analyzing',
  'implementing',
  'validating-task',
  'escalating',
  'final-review',
]);

export const RESUMABLE_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'reviewing-spec',
  'clarifying',
  'constitution-check',
  'reviewing-plan',
  'reviewing-briefs',
  'analyzing',
  'implementing',
  'validating-task',
  'escalating',
  'final-review',
]);

const LIVE_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'researching',
  'specifying',
  'planning',
  'implementing',
  'escalating',
  'final-review',
]);

export function isLivePhase(phase: Phase): boolean {
  return LIVE_PHASES.has(phase);
}

export function isImplementerPhase(phase: Phase): boolean {
  return IMPLEMENTER_PHASES.has(phase);
}

// awaitingContinue overrides phase check: workflow paused mid-turn is always resumable.
export function isResumable(state: WorkflowState): boolean {
  return state.awaitingContinue || RESUMABLE_PHASES.has(state.phase);
}
