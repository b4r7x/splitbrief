import type { Phase } from './schemas/enums.js';

type PhaseRole = 'planner' | 'implementer';

export const WORKFLOW_REWIND_ABORT_REASON = 'workflow-rewind';

const IMPLEMENTER_PHASES: ReadonlySet<Phase> = new Set([
  'implementing',
  'validating-task',
  'escalating',
]);

const PLANNER_TOKEN_PHASES: ReadonlySet<Phase> = new Set([
  'planning',
  'researching',
  'specifying',
  'reviewing-spec',
  'clarifying',
  'constitution-check',
  'reviewing-plan',
  'reviewing-briefs',
  'analyzing',
]);

const IMPLEMENTER_TOKEN_PHASES: ReadonlySet<Phase> = new Set([
  'implementing',
  'validating-task',
  'escalating',
  'final-review',
]);

export function phaseRole(phase: Phase): PhaseRole {
  return IMPLEMENTER_PHASES.has(phase) ? 'implementer' : 'planner';
}

export function phaseTokenRole(phase: Phase): PhaseRole | null {
  if (PLANNER_TOKEN_PHASES.has(phase)) return 'planner';
  if (IMPLEMENTER_TOKEN_PHASES.has(phase)) return 'implementer';
  return null;
}

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

// `idle` is the pre-start phase, not an end: a run resets to it and can start over.
export function isTerminalPhase(phase: Phase): boolean {
  return phase === 'complete';
}
