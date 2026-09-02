import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { EngineEvent } from '../../events/types.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import type { RecoveryResultV1 } from '../../../core/schemas/brief-recovery.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import {
  matchesPersistedExecutionPermit,
  parkedPlanningResult,
  planningResultForState,
  withPlanningResultState,
} from '../planning/handoff.js';

import { publishWarning } from '../events.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { runPlanningPhase } from '../planning/run.js';
import { resumeBriefsApproval } from '../planning/resume-briefs.js';
import { runBriefQuality } from '../planning/brief-quality-run.js';
import type { BriefQualityRecoveryBinding } from '../planning/brief-quality-queue.js';
import { transitionAndSave } from '../state-ops.js';
import { applyBriefQualityResult, stateAfterRecovery } from './phase-recovery-state.js';
import { plannerCallbacksContextOf } from './planner-callbacks-context.js';
import { resumeParkedApproval } from './resume-parked-approval.js';

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

function recoveryHasAdmission(recovery: PhaseRecoveryBinding): boolean {
  return recovery.projection.epochId !== null;
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
  const { projectDir, sessionId, config, planner } = wctx;

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

  const parked = await resumeParkedApproval({
    wctx,
    state,
    setTrackedState,
    recovery: opts.recovery,
    phaseTimings,
    startTime,
  });
  if (parked !== null) return parked;

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
    const planning = await runPlanningPhase({
      wctx: plannerCallbacksContextOf(wctx),
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
