import type { Phase } from '../schemas/enums.js';

type PhaseRole = 'planner' | 'implementer';

const IMPLEMENTER_PHASES: ReadonlySet<Phase> = new Set([
  'implementing',
  'validating-task',
  'escalating',
]);

export function phaseRole(phase: Phase): PhaseRole {
  return IMPLEMENTER_PHASES.has(phase) ? 'implementer' : 'planner';
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

/**
 * The phases where a run is live: a tool call can run, the plan card waits, or a brief check runs.
 * `isLivePhase` names only the first group.
 */
export function isRunLivePhase(phase: Phase): boolean {
  return isLivePhase(phase) || phase === 'reviewing-plan' || phase === 'validating-task';
}

export function isImplementerPhase(phase: Phase): boolean {
  return IMPLEMENTER_PHASES.has(phase);
}

/** The phases where words sent from the composer queue for a seat: a live call, or a brief in BUILD. */
export function isQueuePhase(phase: Phase): boolean {
  return isLivePhase(phase) || isImplementerPhase(phase);
}

// `idle` is the pre-start phase, not an end: a run resets to it and can start over.
export function isTerminalPhase(phase: Phase): boolean {
  return phase === 'complete';
}
