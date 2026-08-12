import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext, PlannerCallbacksContext } from '../types.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { EngineEvent } from '../../events/types.js';
import type { Planner } from '../../planners/types.js';

import { publishWarning } from '../events.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { runPlanningPhase } from '../planning/run.js';
import { resumeBriefsApproval } from '../planning/resume-briefs.js';
import { resumeArtifactApproval } from '../planning/resume-artifact-approval.js';
import { regeneratePlanAndTasks, regenerateTasksIfNeeded } from '../planning/regen.js';
import { runBriefQuality } from '../planning/brief-quality-run.js';
import { transitionAndSave } from '../state-ops.js';
import { APPROVAL_PARKED_ARTIFACT } from './task-execution.js';

export { runTasksAndReview } from './task-execution.js';
export type { RunTasksAndReviewOptions } from './task-execution.js';

export type RunPlanningPhasesOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  savedState: WorkflowState | undefined;
  selectedSkills: SkillMeta[] | undefined;
  phaseTimings: Record<string, number>;
  startTime: number;
  setTrackedState: (s: WorkflowState) => void;
  rewindFeedback?: string | undefined;
};

function isInterruptedPlanningTurn(state: WorkflowState): boolean {
  return (
    state.awaitingContinue &&
    (state.phase === 'researching' || state.phase === 'specifying' || state.phase === 'planning')
  );
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
}): Promise<{ state: WorkflowState; cancelled: boolean; failed: boolean }> {
  const { wctx, setTrackedState } = opts;
  const { projectDir, sessionId, callbacks, bus, metadata, sinks, signal, planner } = wctx;
  const ref = { projectDir, sessionId };
  let { state, regenerated } = opts.approval;
  let tasks = state.tasks;

  if (opts.phase === 'reviewing-spec') {
    state = transitionAndSave(ref, state, { type: 'APPROVE_SPEC' });
    const planAndTasks = await regeneratePlanAndTasks({
      ...ref,
      planner,
      callbacks,
      bus,
      state,
      metadata,
      signal,
      sinks,
    });
    tasks = planAndTasks.tasks;
    state = transitionAndSave(ref, planAndTasks.state, { type: 'PLAN_DONE', tasks });
    setTrackedState(state);

    const planApproval = await resumeArtifactApproval({ wctx, state, phase: 'reviewing-plan' });
    if (planApproval.cancelled) {
      return { state: planApproval.state, cancelled: true, failed: false };
    }
    state = planApproval.state;
    regenerated = planApproval.regenerated;
  }

  const regen = await regenerateTasksIfNeeded({
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
  const quality = await runBriefQuality({
    tasks: regen.tasks,
    state: regen.state,
    planner,
    wctx,
  });
  if (!quality.ok) return quality.result;

  state = transitionAndSave(ref, quality.state, {
    type: 'BRIEFS_READY',
    tasks: quality.tasks,
  });
  const briefs = await resumeBriefsApproval({
    wctx,
    state,
    qualityValidatedTasks: quality.tasks,
  });
  return { state: briefs.state, cancelled: briefs.cancelled, failed: briefs.failed };
}

export async function runPlanningPhases(
  opts: RunPlanningPhasesOptions,
): Promise<{ state: WorkflowState; cancelled: boolean; failed: boolean }> {
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
      const resumed = await resumeBriefsApproval({ wctx: resumeWctx, state });
      state = resumed.state;
      setTrackedState(state);
      phaseTimings.planning = Date.now() - startTime;
      return { state, cancelled: resumed.cancelled, failed: resumed.failed };
    }

    const resumePhase = state.phase;
    if (resumePhase === 'reviewing-spec' || resumePhase === 'reviewing-plan') {
      const resumed = await resumeArtifactApproval({ wctx: resumeWctx, state, phase: resumePhase });
      const continued = resumed.cancelled
        ? { state: resumed.state, cancelled: true, failed: false }
        : await continueApprovedArtifact({
            wctx: resumeWctx,
            phase: resumePhase,
            approval: resumed,
            setTrackedState,
          });
      state = continued.state;
      setTrackedState(state);
      phaseTimings.planning = Date.now() - startTime;
      return { state, cancelled: continued.cancelled, failed: continued.failed };
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
        return { state, cancelled: true, failed: false };
      }
    }

    const plannerFeature = wctx.plannerContext
      ? `${state.feature}\n\n<user-context>\n${wctx.plannerContext}\n</user-context>`
      : state.feature;
    const planning = await runPlanningPhase({
      wctx: {
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
      },
      planner,
      state,
      feature: plannerFeature,
      selectedSkills,
      ...(rewindPending !== undefined && { rewindPending }),
    });
    state = planning.state;
    setTrackedState(state);
    phaseTimings.planning = Date.now() - startTime;
    if (planning.cancelled) return { state, cancelled: true, failed: planning.failed };
  }

  return { state, cancelled: false, failed: false };
}
