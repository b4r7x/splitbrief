import type { Phase, WorkflowState } from './types/index.js';

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
  'planning',
  'reviewing-plan',
  'implementing',
  'validating-task',
  'escalating',
  'final-review',
]);

export const RESUMABLE_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'reviewing-spec', 'reviewing-plan', 'implementing',
  'validating-task', 'escalating', 'final-review',
]);

/** Phases where a planner or implementer call is actively running. */
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

/**
 * A workflow is resumable when in a resumable phase OR when awaiting continue
 * (awaitingContinue overrides the phase check — the workflow paused mid-turn).
 */
export function isResumable(state: WorkflowState): boolean {
  return state.awaitingContinue || RESUMABLE_PHASES.has(state.phase);
}
