import type { Phase } from './schemas/enums.js';
import { PHASES } from './schemas/enums.js';
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
  'analyzing',
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
  'planning',
  'reviewing-plan',
  'reviewing-briefs',
  'implementing',
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

export function isTerminalPhase(phase: Phase): boolean {
  return phase === 'idle' || phase === 'complete';
}

function phaseOrder(phase: Phase): number {
  return PHASES.indexOf(phase);
}

export function canReviseSpec(phase: Phase): boolean {
  return !isTerminalPhase(phase) && phaseOrder(phase) >= phaseOrder('reviewing-spec');
}

export function canRevisePlan(phase: Phase): boolean {
  return !isTerminalPhase(phase) && phaseOrder(phase) >= phaseOrder('reviewing-plan');
}

export function canRedoTask(phase: Phase): boolean {
  return isImplementerPhase(phase);
}

// Recovery and awaitingContinue overlays override the phase check for workflows
// paused mid-turn, but never for terminal phases: completed or idle sessions with
// stale overlays must stay non-resumable so `continue` cannot re-run them.
export function isResumable(state: WorkflowState): boolean {
  if (isTerminalPhase(state.phase)) return false;
  return (
    state.pendingRecovery !== undefined ||
    state.awaitingContinue ||
    RESUMABLE_PHASES.has(state.phase)
  );
}
