import { buildRepoMap } from '../../codebase/repomap.js';
import { resolveMode, resolveApproveLevel } from '../../../core/config/runtime/resolve.js';
import { runQuickPlanning } from './quick.js';
import { runInstantPlanning } from './instant.js';
import { runFullPlanning } from './new.js';
import { runSpeckitPlanning } from './speckit.js';
import { publishEvent } from '../events.js';
import { adviseMode, setAdvisory } from './mode-advisor.js';
import { attachmentsStore } from '../../../stores/workflow/attachments.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './shared.js';

export type { PlanningPhaseOptions } from './shared.js';

export async function runPlanningPhase(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx } = opts;
  const { projectDir, config } = wctx;
  const mode = resolveMode({ config });
  const approveLevel = resolveApproveLevel({ mode, configApprove: config.workflow.approve });

  const advisory = adviseMode(opts.feature, mode);
  setAdvisory(advisory.shouldAdvise ? advisory : null);
  if (advisory.shouldAdvise) {
    wctx.bus.publish({
      type: 'mode_downgrade_advised',
      ts: Date.now(),
      phase: opts.state.phase,
      currentMode: advisory.currentMode,
      suggestedMode: advisory.suggestedMode,
    });
  }

  publishEvent(wctx.bus, {
    type: 'mode_resolved',
    ts: Date.now(),
    phase: opts.state.phase,
    mode,
    approve: approveLevel,
  });

  const codebaseContext = config.codebase?.enabled !== false
    ? await buildRepoMap(projectDir, {
        featureText: opts.feature,
        tokenBudget: config.codebase?.tokenBudget ?? 4000,
        ...(config.codebase?.include && { include: config.codebase.include }),
        ...(config.codebase?.exclude && { exclude: config.codebase.exclude }),
      })
    : undefined;

  const drainedAttachments = attachmentsStore.drain();
  let attachments = drainedAttachments;
  if (drainedAttachments.length > 0 && !opts.planner.capabilities.supportsImages) {
    publishEvent(wctx.bus, {
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
    codebaseContext: codebaseContext || undefined,
    approveLevel,
    ...(attachments.length > 0 ? { attachments } : {}),
  };

  if (mode === 'instant') {
    return runInstantPlanning(optsWithContext);
  }

  if (mode === 'quick') {
    return runQuickPlanning(optsWithContext);
  }

  if (mode === 'speckit') {
    return runSpeckitPlanning(optsWithContext);
  }

  return runFullPlanning(optsWithContext);
}


