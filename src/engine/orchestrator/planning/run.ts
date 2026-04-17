import { DEFAULT_WORKFLOW_MODE } from '../../../core/types/config-options.js';
import { runQuickPlanning } from './quick.js';
import { runFullPlanning } from './new.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './shared.js';

export type { PlanningPhaseOptions } from './shared.js';

export async function runPlanningPhase(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const mode = opts.wctx.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE;

  if (mode === 'quick') {
    return runQuickPlanning(opts);
  }

  const skipPlanApproval = mode === 'standard';
  return runFullPlanning(opts, skipPlanApproval);
}
