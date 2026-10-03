import { resolveApproveLevel } from '../../../core/config/runtime/resolve.js';
import { PLAN_JSON_FILE } from '../../../core/paths.js';
import { readSpecFileOrEmpty } from '../../../core/paths-io.js';
import { planRevisedTurn } from '../../spec/prompts/plan-session.js';
import { resetDriftChainState } from '../drift/chain-state.js';
import { runPlanApproval, runPlanningSession } from './session.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';

export async function runPlanningPhase(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx } = opts;
  const { config } = wctx;
  const approveLevel = resolveApproveLevel(config);

  let state = opts.state;
  if (state.approve !== approveLevel) {
    state = { ...state, approve: approveLevel };
  }

  const drainedAttachments = wctx.drainPendingAttachments ? wctx.drainPendingAttachments() : [];
  let attachments = drainedAttachments;
  if (drainedAttachments.length > 0 && !opts.planner.capabilities.supportsImages) {
    wctx.bus.publish({
      type: 'planner_attachments_dropped',
      ts: Date.now(),
      phase: opts.state.phase,
      count: drainedAttachments.length,
      reason: 'unsupported-backend',
    });
    attachments = [];
  }

  const optsWithContext: PlanningPhaseOptions = {
    ...opts,
    state,
    ...(attachments.length > 0 ? { attachments } : {}),
  };

  const lead =
    optsWithContext.rewindPending === undefined
      ? undefined
      : rewindLead(optsWithContext, optsWithContext.rewindPending.comment);
  const session = await runPlanningSession(optsWithContext, lead);
  if (session.disposition === 'terminal') return session;
  return runPlanApproval(optsWithContext, session.state);
}

/**
 * A correction at the plan card stands on the run as its rewind until a plan compiles, and so does
 * the rewind a state saved by an older version carries. A run that continues before then opens
 * its planning session with that correction and the plan it corrects; the briefs an older rewind
 * reset take their drift chain with them.
 */
function rewindLead(opts: PlanningPhaseOptions, comment: string | undefined): string | undefined {
  const ref = { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId };
  resetDriftChainState(ref);
  const correction = comment?.trim();
  if (correction === undefined || correction === '') return undefined;
  return planRevisedTurn(readSpecFileOrEmpty(ref, PLAN_JSON_FILE), correction);
}
