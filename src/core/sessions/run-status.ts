import { opensPlanGate } from '../pipeline-spec/steps.js';
import type { CrewSeatId } from '../crew/identity.js';
import type { Phase } from '../schemas/enums.js';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import type { GateName, StepCut, StepRef } from '../schemas/run-step.js';
import { fixCyclesOf, type WorkflowState } from '../schemas/workflow.js';

/** What a run waiting for you waits on: the planner's question, a gate, or a halt. */
export type WaitingOn =
  | { kind: 'question' }
  | { kind: 'gate'; gate: GateName; reopens: boolean }
  | { kind: 'halt'; issue: RecoveryIssue };

/** How a stopped run came to rest: a stop it was asked for, an error, or a process that went away. */
export type StoppedOn =
  | {
      kind: 'paused';
      at: StepCut;
      /** The declared files the cut brief had changed; absent when the stop recorded none. */
      kept?: readonly string[];
    }
  | { kind: 'failed'; message: string }
  | { kind: 'seat-wait'; seat: CrewSeatId; tool: string; resetAt: string }
  | { kind: 'interrupted' };

/**
 * An open run at rest is in one of two states. *Waiting for you*: it cannot go on without an
 * answer, a gate decision or a halt decision. *Stopped*: it can go on as it stands.
 */
export type StopReason =
  | { kind: 'waiting-for-you'; on: WaitingOn }
  | { kind: 'stopped'; on: StoppedOn };

export type RunStatus =
  | { kind: 'running' }
  | { kind: 'open'; stop: StopReason; resumeAt: StepRef }
  | { kind: 'ready-to-apply'; override: boolean }
  | { kind: 'closed'; as: 'complete' | 'ended' | 'applied' | 'undone' | 'discarded' };

/** An open run whose process went away mid-step, so nothing recorded where or why it stopped. */
export function processWentAway(status: RunStatus): boolean {
  return (
    status.kind === 'open' &&
    status.stop.kind === 'stopped' &&
    status.stop.on.kind === 'interrupted'
  );
}

export function haltedIssue(status: RunStatus): RecoveryIssue | null {
  if (status.kind !== 'open' || status.stop.on.kind !== 'halt') return null;
  return status.stop.on.issue;
}

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
 * Where a run picks up. First match wins: its planning session's questions, a
 * reviewed workspace waiting for Apply, the gate it is parked at, the brief it
 * was building, the review it reached, else its planning session.
 */
export function resumeStep(state: WorkflowState): StepRef {
  if (state.pendingPlannerConversation !== undefined) return PLANNING_STEP;
  if (awaitsApply(state)) return { kind: 'apply' };
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
      return { kind: 'review', cycle: fixCyclesOf(state).used };
    default:
      return PLANNING_STEP;
  }
}

/** A run whose workspace holds a reviewed result the checkout has not received yet. */
export function awaitsApply(state: WorkflowState): boolean {
  return (
    (state.workspace?.kind === 'worktree' || state.workspace?.kind === 'staged-copy') &&
    state.phase === 'complete' &&
    (state.reviewStatus === 'passed' || state.acceptedAsIs !== undefined) &&
    state.applied === undefined &&
    state.closed === undefined
  );
}

/** A workspace run whose completed Apply its backup can still undo. */
export function canUndoApply(state: WorkflowState): boolean {
  return (
    (state.workspace?.kind === 'worktree' || state.workspace?.kind === 'staged-copy') &&
    state.applied !== undefined &&
    state.applied.undone === undefined
  );
}

/** An Apply that started and did not finish: only Restore or a retried Apply settles it, never End run. */
export function applyUnfinished(state: WorkflowState): boolean {
  return state.applying !== undefined;
}

export function isAnsweredApplyRecovery(issue: RecoveryIssue): issue is RecoveryIssue & {
  reason: 'apply-partial';
  status: 'applying';
  selectedAction: 'retry-same-worker' | 'restore-backup';
} {
  return (
    issue.reason === 'apply-partial' &&
    issue.status === 'applying' &&
    (issue.selectedAction === 'retry-same-worker' || issue.selectedAction === 'restore-backup')
  );
}

function seatToolWord(state: WorkflowState, seat: CrewSeatId): string {
  if (seat === 'plan') return state.plannerTool ?? seat;
  if (seat === 'build') return state.implementerTool ?? seat;
  return state.reviewerTool ?? state.plannerTool ?? seat;
}

/**
 * How a run stands, from the state it saved and whether a process still holds it.
 * A passing review, or a failed one accepted as is, closes a run without a workspace or on the
 * checkout; a run with a worktree or staged copy becomes ready to apply once no process holds it
 * (a process that holds it is applying it), and Apply, Discard or End close it. An Apply undone later leaves the run closed as undone. A halt still waiting for an
 * answer keeps either open.
 */
export function deriveRunStatus(
  input: Readonly<{
    state: WorkflowState;
    liveness: 'alive' | 'not-alive';
  }>,
): RunStatus {
  const { state } = input;
  if (state.closed !== undefined) {
    const undone = state.closed.as === 'applied' && state.applied?.undone !== undefined;
    return { kind: 'closed', as: undone ? 'undone' : state.closed.as };
  }
  if (
    state.phase === 'complete' &&
    (state.reviewStatus === 'passed' || state.acceptedAsIs !== undefined) &&
    state.pendingRecovery === undefined &&
    (state.workspace === undefined || state.workspace.kind === 'checkout')
  ) {
    return { kind: 'closed', as: 'complete' };
  }
  if (input.liveness === 'alive') return { kind: 'running' };
  if (
    awaitsApply(state) &&
    state.pendingRecovery === undefined &&
    state.interruptedStep === undefined &&
    !applyUnfinished(state)
  ) {
    return { kind: 'ready-to-apply', override: state.reviewStatus !== 'passed' };
  }

  const waiting = (on: WaitingOn): RunStatus => ({
    kind: 'open',
    stop: { kind: 'waiting-for-you', on },
    resumeAt: resumeStep(state),
  });
  const stopped = (on: StoppedOn): RunStatus => ({
    kind: 'open',
    stop: { kind: 'stopped', on },
    resumeAt: resumeStep(state),
  });

  if (state.pendingRecovery !== undefined) {
    return waiting({ kind: 'halt', issue: state.pendingRecovery });
  }
  if (state.seatWait !== undefined) {
    return stopped({
      kind: 'seat-wait',
      seat: state.seatWait.seat,
      tool: seatToolWord(state, state.seatWait.seat),
      resetAt: state.seatWait.resetAt,
    });
  }
  if (
    state.pendingPlannerConversation !== undefined &&
    !state.pendingPlannerConversation.answered
  ) {
    return waiting({ kind: 'question' });
  }
  // The stop records where it landed. States written before it did fall back to
  // the captured partial: only a call cut in flight leaves one.
  if (state.interruptedStep !== undefined) {
    const { cut, partialRef, kept } = state.interruptedStep;
    return stopped({
      kind: 'paused',
      at: cut ?? (partialRef === undefined ? 'boundary' : 'mid-step'),
      ...(kept !== undefined && kept.length > 0 && { kept }),
    });
  }
  if (state.awaitingContinue) return stopped({ kind: 'paused', at: 'mid-step' });

  const gate = parkedGate(state);
  if (gate !== undefined) {
    return waiting({ kind: 'gate', gate, reopens: reopensPlanCard(state) });
  }
  if (state.lastFailure !== undefined) {
    return stopped({ kind: 'failed', message: state.lastFailure.message });
  }
  return stopped({ kind: 'interrupted' });
}
