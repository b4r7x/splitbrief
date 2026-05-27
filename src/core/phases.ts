import type { Phase } from './schemas/enums.js';
import type { WorkflowState } from './schemas/workflow.js';

type PhaseRole = 'planner' | 'implementer';

const IMPLEMENTER_PHASES: ReadonlySet<Phase> = new Set([
  'implementing',
  'validating-task',
  'escalating',
]);

const PLANNER_COST_PHASES: ReadonlySet<Phase> = new Set([
  'planning',
  'researching',
  'specifying',
  'reviewing-spec',
  'clarifying',
  'constitution-check',
  'reviewing-plan',
  'reviewing-briefs',
]);

const IMPLEMENTER_COST_PHASES: ReadonlySet<Phase> = new Set([
  'implementing',
  'validating-task',
  'escalating',
  'final-review',
]);

export function phaseRole(phase: Phase): PhaseRole {
  return IMPLEMENTER_PHASES.has(phase) ? 'implementer' : 'planner';
}

export function phaseCostRole(phase: Phase): PhaseRole | null {
  if (PLANNER_COST_PHASES.has(phase)) return 'planner';
  if (IMPLEMENTER_COST_PHASES.has(phase)) return 'implementer';
  return null;
}

const RESUMABLE_PHASES: ReadonlySet<Phase> = new Set<Phase>([
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
