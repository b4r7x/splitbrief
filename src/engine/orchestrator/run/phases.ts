import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext, PlannerCallbacksContext } from '../types.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { EngineEvent } from '../../events/types.js';
import type { Planner } from '../../planners/types.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import type { RecoveryResultV1 } from '../../../core/schemas/brief-recovery.js';
import { RecoveryResultV1Schema } from '../../../core/schemas/brief-recovery.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import {
  matchesPersistedExecutionPermit,
  parkedPlanningResult,
  planningResultForState,
  terminalPlanningResult,
  withPlanningResultState,
} from '../planning/handoff.js';

import { publishWarning } from '../events.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { runPlanningPhase } from '../planning/run.js';
import { resumeBriefsApproval } from '../planning/resume-briefs.js';
import { resumeArtifactApproval } from '../planning/resume-artifact-approval.js';
import { regeneratePlanAndTasks, regenerateTasksIfNeeded } from '../planning/regen.js';
import { runBriefQuality } from '../planning/brief-quality-run.js';
import type { BriefQualityRecoveryBinding } from '../planning/brief-quality-preparation.js';
import { transitionAndSave } from '../state-ops.js';
import { APPROVAL_PARKED_ARTIFACT } from './task-execution.js';

export type RunPlanningPhasesOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  savedState: WorkflowState | undefined;
  selectedSkills: SkillMeta[] | undefined;
  phaseTimings: Record<string, number>;
  startTime: number;
  setTrackedState: (s: WorkflowState) => void;
  rewindFeedback?: string | undefined;
  /** Optional for direct producer use; the workflow owner always supplies it. */
  recovery?: PhaseRecoveryBinding;
};

/**
 * The phase runner is a client of the recovery controller.  The binding is
 * supplied by the owner; this module only carries the projection and result
 * between the quality admission and the approval client.
 */
export type PhaseRecoveryBinding = BriefQualityRecoveryBinding & {
  projection: BriefRecoveryProjectionV1;
  admission: RecoveryResultV1;
  readState: () => WorkflowState;
  writeState: (state: WorkflowState) => void;
};

function stateAfterRecovery(state: WorkflowState, recovery: PhaseRecoveryBinding): WorkflowState {
  try {
    return recovery.readState();
  } catch {
    // Keep the state already supplied by the owner when its refresh seam fails.
  }
  return state;
}

function recoveryHasAdmission(recovery: PhaseRecoveryBinding): boolean {
  return recovery.projection.epochId !== null;
}

function applyBriefQualityResult(
  recovery: PhaseRecoveryBinding,
  result: Awaited<ReturnType<typeof runBriefQuality>>,
): void {
  recovery.projection = result.projection;
  recovery.authority = {
    ...recovery.authority,
    stateRevision: result.projection.stateRevision,
  };
  const parsed = RecoveryResultV1Schema.safeParse(result.recovery);
  if (parsed.success) recovery.admission = parsed.data;
}

function isInterruptedPlanningTurn(state: WorkflowState): boolean {
  return (
    state.awaitingContinue &&
    (state.phase === 'researching' || state.phase === 'specifying' || state.phase === 'planning')
  );
}

async function exitNonApprovalBrief(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  tasks: WorkflowState['tasks'];
  recovery: PhaseRecoveryBinding;
}): Promise<PlanningPhaseResult> {
  const state = stateAfterRecovery(opts.state, opts.recovery);
  return planningResultForState({
    sessionId: opts.wctx.sessionId,
    state,
    projection: opts.recovery.projection,
    tasks: opts.tasks,
  });
}

// Continues a resumed artifact approval from the persisted artifacts, never from a fresh
// planning turn: an approved spec.md drives plan/brief regeneration and then the plan gate,
// and a plan the planner revised at either gate invalidates the briefs it produced, so they
// are regenerated before the briefs gate reads tasks.md. This is what rewind.ts does after
// its own APPROVE_SPEC; re-planning would overwrite the artifact just approved and re-prompt
// the same gate.
async function continueApprovedArtifact(opts: {
  wctx: PlannerCallbacksContext & { planner: Planner };
  phase: 'reviewing-spec' | 'reviewing-plan';
  approval: { state: WorkflowState; regenerated: boolean };
  setTrackedState: (s: WorkflowState) => void;
  recovery: PhaseRecoveryBinding;
}): Promise<PlanningPhaseResult> {
  const { wctx, setTrackedState, recovery } = opts;
  const { projectDir, sessionId, callbacks, bus, metadata, sinks, signal, planner } = wctx;
  const ref = { projectDir, sessionId };
  let { state, regenerated } = opts.approval;
  let tasks = state.tasks;

  if (opts.phase === 'reviewing-spec') {
    state = transitionAndSave(ref, state, { type: 'APPROVE_SPEC' });
    let planAndTasks: Awaited<ReturnType<typeof regeneratePlanAndTasks>>;
    try {
      planAndTasks = await regeneratePlanAndTasks({
        ...ref,
        planner,
        callbacks,
        bus,
        state,
        metadata,
        signal,
        sinks,
      });
    } catch {
      const preserved = stateAfterRecovery(state, recovery);
      setTrackedState(preserved);
      return parkedPlanningResult(wctx.sessionId, preserved, recovery.projection);
    }
    tasks = planAndTasks.tasks;
    state = transitionAndSave(ref, planAndTasks.state, {
      type: 'PLAN_DONE',
      tasks,
    });
    setTrackedState(state);

    const planApproval = await resumeArtifactApproval({
      wctx,
      state,
      phase: 'reviewing-plan',
    });
    if (planApproval.cancelled) {
      return terminalPlanningResult(planApproval.state, 'cancelled');
    }
    state = planApproval.state;
    regenerated = planApproval.regenerated;
  }

  let regen: Awaited<ReturnType<typeof regenerateTasksIfNeeded>>;
  try {
    regen = await regenerateTasksIfNeeded({
      ...ref,
      regenerated,
      planner,
      callbacks,
      bus,
      state,
      tasks,
      metadata,
      signal,
      sinks,
    });
  } catch {
    const preserved = stateAfterRecovery(state, recovery);
    setTrackedState(preserved);
    return parkedPlanningResult(wctx.sessionId, preserved, recovery.projection);
  }
  state = regen.state;
  tasks = regen.tasks;

  let quality: Awaited<ReturnType<typeof runBriefQuality>>;
  try {
    quality = await runBriefQuality({
      tasks,
      state,
      planner,
      wctx,
      recovery,
    });
  } catch {
    const preserved = stateAfterRecovery(state, recovery);
    setTrackedState(preserved);
    return parkedPlanningResult(wctx.sessionId, preserved, recovery.projection);
  }
  applyBriefQualityResult(recovery, quality);
  const latest = stateAfterRecovery(quality.state, recovery);
  setTrackedState(latest);
  if (!quality.ok) return withPlanningResultState(quality.result, latest);

  const briefs = await resumeBriefsApproval({
    wctx,
    state: latest,
    qualityValidatedTasks: quality.tasks,
    recovery,
  });
  const finalState = stateAfterRecovery(briefs.state, recovery);
  setTrackedState(finalState);
  return withPlanningResultState(briefs, finalState);
}

export async function runPlanningPhases(
  opts: RunPlanningPhasesOptions,
): Promise<PlanningPhaseResult> {
  const {
    wctx,
    savedState,
    selectedSkills,
    phaseTimings,
    startTime,
    setTrackedState,
    rewindFeedback,
  } = opts;
  let { state } = opts;
  const { projectDir, sessionId, config, callbacks, planner } = wctx;

  const interrupted = isInterruptedPlanningTurn(state);
  const shouldRunPlanning = !savedState || Boolean(savedState.rewindPending) || interrupted;
  const rewindPending =
    savedState?.rewindPending === undefined
      ? undefined
      : {
          ...savedState.rewindPending,
          ...(rewindFeedback !== undefined && { comment: rewindFeedback }),
        };

  if (interrupted) {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'CONTINUE_TURN' });
    setTrackedState(state);
  }

  const parkedArtifact = APPROVAL_PARKED_ARTIFACT[state.phase];
  if (parkedArtifact !== undefined) {
    if (opts.recovery === undefined) return parkedPlanningResult(sessionId, state);

    const resumeWctx: PlannerCallbacksContext & { planner: Planner } = {
      projectDir,
      sessionId,
      config,
      callbacks,
      bus: wctx.bus,
      signal: wctx.signal,
      metadata: wctx.metadata,
      sinks: wctx.sinks,
      drainPendingAttachments: wctx.drainPendingAttachments,
      ...(wctx.modelCache !== undefined && { modelCache: wctx.modelCache }),
      ...(wctx.detectedContextLength !== undefined && {
        detectedContextLength: wctx.detectedContextLength,
      }),
      planner,
    };

    if (state.phase === 'reviewing-briefs') {
      const resumed = await resumeBriefsApproval({
        wctx: resumeWctx,
        state,
        recovery: opts.recovery,
      });
      state = stateAfterRecovery(resumed.state, opts.recovery);
      setTrackedState(state);
      phaseTimings.planning = Date.now() - startTime;
      return withPlanningResultState(resumed, state);
    }

    const resumePhase = state.phase;
    if (resumePhase === 'reviewing-spec' || resumePhase === 'reviewing-plan') {
      const resumed = await resumeArtifactApproval({ wctx: resumeWctx, state, phase: resumePhase });
      const continued = resumed.cancelled
        ? terminalPlanningResult(resumed.state, 'cancelled')
        : await continueApprovedArtifact({
            wctx: resumeWctx,
            phase: resumePhase,
            approval: resumed,
            setTrackedState,
            recovery: opts.recovery,
          });
      state = continued.state;
      setTrackedState(state);
      phaseTimings.planning = Date.now() - startTime;
      return withPlanningResultState(continued, state);
    }
  }

  if (shouldRunPlanning) {
    if (config.hooks) {
      const prePlanPayload: EngineEvent = {
        type: 'workflow_started',
        ts: Date.now(),
        phase: state.phase,
        feature: state.feature,
      };
      const pre = await runPreHooks(config.hooks, 'pre_planning', prePlanPayload, {
        projectDir,
        sessionId,
      });
      if (!pre.allow) {
        publishWarning({
          bus: wctx.bus,
          phase: state.phase,
          message: `pre_planning blocked: ${pre.reason ?? 'hook denied'}`,
        });
        return { disposition: 'terminal', state, outcome: 'cancelled' };
      }
    }

    const plannerFeature = wctx.plannerContext
      ? `${state.feature}\n\n<user-context>\n${wctx.plannerContext}\n</user-context>`
      : state.feature;
    const planningWctx = {
      projectDir,
      sessionId,
      config,
      callbacks,
      bus: wctx.bus,
      signal: wctx.signal,
      metadata: wctx.metadata,
      sinks: wctx.sinks,
      drainPendingAttachments: wctx.drainPendingAttachments,
      ...(wctx.modelCache !== undefined && { modelCache: wctx.modelCache }),
      ...(wctx.detectedContextLength !== undefined && {
        detectedContextLength: wctx.detectedContextLength,
      }),
    };
    const planning = await runPlanningPhase({
      wctx: planningWctx,
      planner,
      state,
      feature: plannerFeature,
      selectedSkills,
      ...(rewindPending !== undefined && { rewindPending }),
      ...(opts.recovery !== undefined ? { recovery: opts.recovery } : {}),
    });
    state = planning.state;
    const planningTasks =
      planning.disposition === 'ready-for-tasks' ? [...planning.tasks] : state.tasks;
    // A rewind producer may already have committed recovery evidence. Its
    // returned planning state is intentionally pre-admission, so do not feed
    // that stale snapshot back into the owner's authority holder. Normal
    // producers have no recovery record yet and must refresh authority here
    // before the owner performs admission.
    const producerAlreadyAdmitted =
      opts.recovery !== undefined && recoveryHasAdmission(opts.recovery);
    if (producerAlreadyAdmitted && opts.recovery !== undefined) {
      state = stateAfterRecovery(state, opts.recovery);
    } else {
      setTrackedState(state);
    }
    phaseTimings.planning = Date.now() - startTime;
    if (planning.disposition === 'terminal') {
      setTrackedState(state);
      return withPlanningResultState(planning, state);
    }

    if (planning.disposition === 'ready-for-tasks') {
      if (opts.recovery === undefined || matchesPersistedExecutionPermit(planning, state)) {
        return withPlanningResultState(planning, state);
      }
      return parkedPlanningResult(wctx.sessionId, state, opts.recovery.projection);
    }

    // A producer can be used independently of the workflow owner. In that
    // case its result is the handoff; do not attempt recovery continuation or
    // materialization without an authoritative binding.
    if (opts.recovery === undefined) {
      return withPlanningResultState(planning, state);
    }

    if (!producerAlreadyAdmitted) {
      const quality = await runBriefQuality({
        tasks: planningTasks,
        state,
        planner,
        wctx,
        recovery: opts.recovery,
      });
      applyBriefQualityResult(opts.recovery, quality);
      state = stateAfterRecovery(quality.state, opts.recovery);
      setTrackedState(state);
      if (!quality.ok) {
        return withPlanningResultState(quality.result, state);
      }
    }

    const continuation = opts.recovery.projection.continuation;
    if (continuation?.kind === 'approval') {
      if (opts.recovery.admission.kind !== 'ready' && opts.recovery.projection.status !== 'ready') {
        return parkedPlanningResult(wctx.sessionId, state, opts.recovery.projection);
      }
      const briefs = await resumeBriefsApproval({
        wctx: { ...wctx, planner },
        state,
        qualityValidatedTasks: planningTasks,
        recovery: opts.recovery,
      });
      state = stateAfterRecovery(briefs.state, opts.recovery);
      setTrackedState(state);
      return withPlanningResultState(briefs, state);
    }
    const exited = await exitNonApprovalBrief({
      wctx,
      state,
      tasks: planningTasks,
      recovery: opts.recovery,
    });
    state = exited.state;
    setTrackedState(state);
    return exited;
  }

  return planningResultForState({
    sessionId,
    state,
    ...(opts.recovery === undefined ? {} : { projection: opts.recovery.projection }),
  });
}
