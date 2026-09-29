import type { WorkflowState } from '../../../core/schemas/workflow.js';
import {
  blocksBriefsGate,
  resolveApproveLevel,
  resolveMode,
} from '../../../core/config/runtime/resolve.js';
import type { PlannerCallbacksContext, WorkflowContext } from '../types.js';
import type { Planner } from '../../planners/types.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import { resumeBriefsApproval } from '../planning/resume-briefs.js';
import { resumeArtifactApproval } from '../planning/resume-artifact-approval.js';
import { invalidateFrom } from '../planning/invalidate.js';
import { adviseMode } from '../planning/mode-advisor.js';
import { admitBriefs } from '../planning/run.js';
import { runPlanningSteps } from '../planning/steps.js';
import { plannerCallbacksContextOf } from './planner-callbacks-context.js';
import { APPROVAL_PARKED_ARTIFACT } from './task-execution.js';

// Continues a resumed artifact approval from the persisted artifacts, never from a fresh
// planning turn: the approved artifact stays, everything the approval invalidated is
// dropped, and the step loop re-runs exactly the calls that lost their artifact before
// the next gate opens. The briefs then take the path of a run that never stopped: the
// quality pass and its bounded repair come before the briefs gate.
export async function continueApprovedArtifact(opts: {
  wctx: PlannerCallbacksContext & { planner: Planner };
  phase: 'reviewing-spec' | 'reviewing-plan';
  approval: { state: WorkflowState; regenerated: boolean };
  setTrackedState: (s: WorkflowState) => void;
}): Promise<PlanningPhaseResult> {
  const { wctx, setTrackedState } = opts;
  const { projectDir, sessionId, config, planner } = wctx;
  const ref = { projectDir, sessionId };
  const { state, regenerated } = opts.approval;
  const gate = opts.phase === 'reviewing-spec' ? 'spec' : 'plan';

  if (regenerated) invalidateFrom(ref, gate);

  const steps = await runPlanningSteps({
    wctx,
    planner,
    state,
    feature: state.feature,
    startAt: gate,
    passedGates: gate === 'spec' ? ['spec'] : ['spec', 'plan'],
  });
  setTrackedState(steps.state);
  if (steps.disposition === 'terminal') return steps;

  // Mode and approval level resolve as `runPlanningPhase` resolves them; the risk reads the saved
  // feature and `@file` context, as `adviseRun` does for a continued run.
  const mode = resolveMode({ config, savedMode: state.mode });
  const briefs = await admitBriefs({
    wctx,
    planner,
    state: steps.state,
    tasks: steps.tasks,
    mode,
    approveLevel: resolveApproveLevel({
      mode,
      configApprove: config.workflow.approve,
      savedApprove: state.approve,
    }),
    risk: adviseMode([state.feature, state.plannerContext].filter(Boolean).join('\n\n'), mode).risk,
  });
  setTrackedState(briefs.state);
  return briefs;
}

/** Resumes a run parked at an approval gate. Returns null when the state is not parked. */
export async function resumeParkedApproval(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  phaseTimings: Record<string, number>;
  startTime: number;
}): Promise<PlanningPhaseResult | null> {
  const { wctx, state, setTrackedState, phaseTimings, startTime } = opts;
  if (APPROVAL_PARKED_ARTIFACT[state.phase] === undefined) return null;

  const gate =
    state.phase === 'reviewing-spec'
      ? 'spec'
      : state.phase === 'reviewing-plan'
        ? 'plan'
        : 'briefs';
  let correction = wctx.continuation?.take({ kind: 'gate', gate })?.steer?.trim();
  if (correction === '') correction = undefined;
  const resumeWctx: PlannerCallbacksContext & { planner: Planner } = {
    ...plannerCallbacksContextOf(wctx),
    callbacks: {
      ...wctx.callbacks,
      onApprovalNeeded: async (type, input) => {
        if (type !== gate || correction === undefined) {
          return wctx.callbacks.onApprovalNeeded(type, input);
        }
        const comment = correction;
        correction = undefined;
        return { approved: false, action: 'revise', comment, recorded: true };
      },
    },
    planner: wctx.planner,
  };

  if (state.phase === 'reviewing-spec' || state.phase === 'reviewing-plan') {
    const phase = state.phase;
    const resumed = await resumeArtifactApproval({ wctx: resumeWctx, state, phase });
    if (correction !== undefined && !resumed.closed && !resumed.cancelled) {
      wctx.bus.publish({
        type: 'warning',
        ts: Date.now(),
        phase: state.phase,
        message: `Your correction was not applied: the ${gate} gate no longer opens at this run's approval level.`,
      });
    }
    const continued: PlanningPhaseResult = resumed.closed
      ? { disposition: 'terminal', state: resumed.state, outcome: 'closed' }
      : resumed.cancelled
        ? { disposition: 'terminal', state: resumed.state, outcome: 'cancelled' }
        : await continueApprovedArtifact({
            wctx: resumeWctx,
            phase,
            approval: resumed,
            setTrackedState,
          });
    setTrackedState(continued.state);
    phaseTimings.planning = Date.now() - startTime;
    return continued;
  }

  const mode = resolveMode({ config: wctx.config, savedMode: state.mode });
  const approveLevel = resolveApproveLevel({
    mode,
    configApprove: wctx.config.workflow.approve,
    savedApprove: state.approve,
  });
  if (correction !== undefined && !blocksBriefsGate(mode, approveLevel)) {
    wctx.bus.publish({
      type: 'warning',
      ts: Date.now(),
      phase: state.phase,
      message: `Your correction was not applied: the ${gate} gate no longer opens at this run's approval level.`,
    });
  }
  const briefs = await resumeBriefsApproval({ wctx: resumeWctx, state });
  setTrackedState(briefs.state);
  phaseTimings.planning = Date.now() - startTime;
  return briefs;
}
