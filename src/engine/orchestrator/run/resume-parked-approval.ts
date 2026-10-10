import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { reopensPlanCard } from '../../../core/sessions/run-status.js';
import type { PlannerCallbacksContext, WorkflowContext } from '../types.js';
import type { Planner } from '../../planners/types.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import { runPlanApproval } from '../planning/session.js';
import { plannerCallbacksContextOf, plannerFeature } from './planner-callbacks-context.js';

/** Re-opens the plan card of a run parked at it; returns null for any run that does not reopen it. */
export async function resumeParkedApproval(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  phaseTimings: Record<string, number>;
  startTime: number;
}): Promise<PlanningPhaseResult | null> {
  const { wctx, state, setTrackedState, phaseTimings, startTime } = opts;
  if (!reopensPlanCard(state)) return null;

  let correction = wctx.continuation?.take({ kind: 'gate', gate: 'plan' })?.steer;
  if (correction?.text.trim() === '') correction = undefined;
  const resumeWctx: PlannerCallbacksContext & { planner: Planner } = {
    ...plannerCallbacksContextOf(wctx),
    callbacks: {
      ...wctx.callbacks,
      onApprovalNeeded: async (type, input, confirms) => {
        if (type !== 'plan' || correction === undefined) {
          return wctx.callbacks.onApprovalNeeded(type, input, confirms);
        }
        const message = correction;
        correction = undefined;
        return { approved: false, action: 'revise', message, recorded: true };
      },
    },
    planner: wctx.planner,
  };

  const approved = await runPlanApproval(
    {
      wctx: resumeWctx,
      planner: wctx.planner,
      state,
      feature: plannerFeature(state.feature, wctx.plannerContext),
    },
    state,
  );
  setTrackedState(approved.state);
  phaseTimings.planning = Date.now() - startTime;
  return approved;
}
