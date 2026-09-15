import { plannerStepsFor } from '../pipeline-spec/steps.js';
import type { Phase } from '../schemas/enums.js';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import type { GateName, PlannerCall, StepRef } from '../schemas/run-step.js';
import type { WorkflowState } from '../schemas/workflow.js';

export type StopReason =
  | { kind: 'paused'; at: 'mid-step' | 'boundary' }
  | { kind: 'waiting'; gate: GateName }
  | { kind: 'halted'; issue: RecoveryIssue }
  | { kind: 'failed'; message: string }
  | { kind: 'interrupted' };

export type RunStatus =
  | { kind: 'running' }
  | { kind: 'open'; stop: StopReason; resumeAt: StepRef }
  | { kind: 'closed'; as: 'complete' | 'ended' };

export type ArtifactPresence = {
  research: boolean;
  spec: boolean;
  plan: boolean;
  tasks: boolean;
  clarifications: boolean;
  constitution: boolean;
  analyze: boolean;
  review: boolean;
};

/** Artifacts shape `resumeAt` only, never the status kind; callers that want the kind pass this. */
export const NO_ARTIFACTS: ArtifactPresence = {
  research: false,
  spec: false,
  plan: false,
  tasks: false,
  clarifications: false,
  constitution: false,
  analyze: false,
  review: false,
};

const CALL_ARTIFACT: Record<PlannerCall, keyof ArtifactPresence> = {
  research: 'research',
  spec: 'spec',
  plan: 'plan',
  tasks: 'tasks',
  clarify: 'clarifications',
  constitution: 'constitution',
  analyze: 'analyze',
};

const PHASE_CALL: Partial<Record<Phase, PlannerCall>> = {
  researching: 'research',
  specifying: 'spec',
  clarifying: 'clarify',
  'constitution-check': 'constitution',
  planning: 'plan',
  analyzing: 'analyze',
};

const PHASE_GATE: Partial<Record<Phase, GateName>> = {
  'reviewing-spec': 'spec',
  'reviewing-plan': 'plan',
  'reviewing-briefs': 'briefs',
};

/**
 * Where a run picks up. First match wins: the gate it is parked at, the brief it
 * was building, the review it reached, else the first planner artifact its mode
 * has not written yet.
 */
export function resumeStep(state: WorkflowState, artifacts: ArtifactPresence): StepRef {
  const gate = PHASE_GATE[state.phase];
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
      return { kind: 'planner', call: nextPlannerCall(state, artifacts) };
  }
}

function nextPlannerCall(state: WorkflowState, artifacts: ArtifactPresence): PlannerCall {
  const order = plannerStepsFor(state.mode ?? 'standard', state.approve ?? 'default').map(
    (step) => step.call,
  );
  const current = PHASE_CALL[state.phase];
  const from = current === undefined ? 0 : Math.max(order.indexOf(current), 0);
  for (let index = from; index < order.length; index++) {
    const call = order[index];
    if (call !== undefined && !artifacts[CALL_ARTIFACT[call]]) return call;
  }
  return order[order.length - 1] ?? 'tasks';
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
    artifacts: ArtifactPresence;
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
    resumeAt: resumeStep(state, input.artifacts),
  });

  if (state.pendingRecovery !== undefined) {
    return open({ kind: 'halted', issue: state.pendingRecovery });
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

  const gate = PHASE_GATE[state.phase];
  if (gate !== undefined) return open({ kind: 'waiting', gate });
  if (state.lastFailure !== undefined) {
    return open({ kind: 'failed', message: state.lastFailure.message });
  }
  return open({ kind: 'interrupted' });
}
