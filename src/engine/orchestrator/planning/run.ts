import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import { buildRepoMap } from '../../codebase/repomap.js';
import { runQuickPlanning } from './quick.js';
import { runFullPlanning } from './new.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './shared.js';

export type { PlanningPhaseOptions } from './shared.js';

export async function runPlanningPhase(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx } = opts;
  const { projectDir, config } = wctx;
  const mode = config.workflow.mode ?? DEFAULT_WORKFLOW_MODE;

  const codebaseContext = config.codebase?.enabled !== false
    ? await buildRepoMap(projectDir, {
        featureText: opts.feature,
        tokenBudget: config.codebase?.tokenBudget ?? 4000,
        ...(config.codebase?.include && { include: config.codebase.include }),
        ...(config.codebase?.exclude && { exclude: config.codebase.exclude }),
      })
    : undefined;

  const optsWithContext: PlanningPhaseOptions = { ...opts, codebaseContext: codebaseContext || undefined };

  if (mode === 'quick') {
    return runQuickPlanning(optsWithContext);
  }

  const skipPlanApproval = mode === 'standard';
  return runFullPlanning(optsWithContext, skipPlanApproval);
}
