import { opensPlanGate } from '../pipeline-spec/steps.js';
import type { Phase } from '../schemas/enums.js';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import type { GateName, StepRef } from '../schemas/run-step.js';
import type { WorkflowState } from '../schemas/workflow.js';

export type StopReason =
  | { kind: 'input-required' }
  | { kind: 'paused'; at: 'mid-step' | 'boundary' }
  | { kind: 'waiting'; gate: GateName; reopens: boolean }
  | { kind: 'halted'; issue: RecoveryIssue }
  | { kind: 'failed'; message: string }
  | { kind: 'interrupted' };

export type RunStatus =
  | { kind: 'running' }
  | { kind: 'open'; stop: StopReason; resumeAt: StepRef }
  | { kind: 'closed'; as: 'complete' | 'ended' };

const PHASE_GATE: Partial<Record<Phase, GateName>> = {
  'reviewing-spec': 'spec',
  'reviewing-plan': 'plan',
  'reviewing-briefs': 'briefs',
};

/**
 * The gate a saved phase waits at. The briefs of a run whose steps open no plan gate once waited in
 * `reviewing-plan` too, so a state that records such a run there is at its briefs call. A state that
 * records neither its mode nor its approve level stays at the gate it names, and so does a planning
 * session's plan, which enters `reviewing-plan` only when its approval opens.
 */
function parkedGate(state: WorkflowState): GateName | undefined {
  if (state.phase === 'reviewing-plan' && state.plan === undefined && recordsNoPlanGate(state)) {
    return undefined;
  }
  return PHASE_GATE[state.phase];
}

/**
 * Only a run parked at a typed plan's card reopens it. A run parked at a spec, plan or briefs gate
 * without one stopped inside the old multi-step chain, and continues as one planning session.
 */
export function reopensPlanCard(state: WorkflowState): boolean {
  return state.phase === 'reviewing-plan' && state.plan !== undefined;
}

function recordsNoPlanGate(state: WorkflowState): boolean {
  if (state.mode === 'quick') return true;
  return state.approve !== undefined && !opensPlanGate(state.mode ?? 'standard', state.approve);
}

/** The one step a planning session runs, whatever planner phase an older run saved. */
const PLANNING_STEP: StepRef = { kind: 'planner', call: 'plan' };

/**
 * Where a run picks up. First match wins: its planning session's questions, the gate
 * it is parked at, the brief it was building, the review it reached, else its
 * planning session.
 */
export function resumeStep(state: WorkflowState): StepRef {
  if (state.pendingPlannerConversation !== undefined) return PLANNING_STEP;
  const gate = parkedGate(state);
  if (gate !== undefined) return { kind: 'gate', gate };

  switch (state.phase) {
    case 'implementing':
    case 'validating-task':
    case 'escalating': {
      const task = state.tasks[state.currentTaskIndex];
      return task === undefined
        ? { kind: 'review', cycle: 0 }
        : { kind: 'brief', taskId: task.id, attempt: state.attempt };
    }
    case 'final-review':
    case 'complete':
      return { kind: 'review', cycle: state.reviewFixes?.cycle ?? 0 };
    default:
      return PLANNING_STEP;
  }
}

/**
 * How a run stands, from the state it saved and whether a process still holds it.
 * A run stays open until it is explicitly closed: passing the final review closes
 * it as complete, ending it closes it as ended, and everything else is continuable.
 */
export function deriveRunStatus(
  input: Readonly<{
    state: WorkflowState;
    liveness: 'alive' | 'not-alive';
  }>,
): RunStatus {
  const { state } = input;
  if (state.closed !== undefined) return { kind: 'closed', as: 'ended' };
  if (state.phase === 'complete' && state.reviewStatus === 'passed') {
    return { kind: 'closed', as: 'complete' };
  }
  if (input.liveness === 'alive') return { kind: 'running' };

  const open = (stop: StopReason): RunStatus => ({
    kind: 'open',
    stop,
    resumeAt: resumeStep(state),
  });

  if (state.pendingRecovery !== undefined) {
    return open({ kind: 'halted', issue: state.pendingRecovery });
  }
  if (
    state.pendingPlannerConversation !== undefined &&
    !state.pendingPlannerConversation.answered
  ) {
    return open({ kind: 'input-required' });
  }
  // The stop records where it landed. States written before it did fall back to
  // the captured partial: only a call cut in flight leaves one.
  if (state.interruptedStep !== undefined) {
    const { cut, partialRef } = state.interruptedStep;
    return open({
      kind: 'paused',
      at: cut ?? (partialRef === undefined ? 'boundary' : 'mid-step'),
    });
  }
  if (state.awaitingContinue) return open({ kind: 'paused', at: 'mid-step' });

  const gate = parkedGate(state);
  if (gate !== undefined) return open({ kind: 'waiting', gate, reopens: reopensPlanCard(state) });
  if (state.lastFailure !== undefined) {
    return open({ kind: 'failed', message: state.lastFailure.message });
  }
  return open({ kind: 'interrupted' });
}
