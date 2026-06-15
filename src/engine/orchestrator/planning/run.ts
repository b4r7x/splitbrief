import { buildRepoMap } from '../../codebase/repomap.js';
import { resolveMode, resolveApproveLevel } from '../../../core/config/runtime/resolve.js';
import { saveState } from '../../../core/state/persistence.js';
import { runQuickPlanning } from './quick.js';
import { runInstantPlanning } from './instant.js';
import { runFullPlanning } from './full.js';
import { runSpeckitPlanning } from './speckit.js';
import { adviseMode } from './mode-advisor.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';

export async function runPlanningPhase(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx } = opts;
  const { projectDir, sessionId, config } = wctx;
  const mode = resolveMode({ config, savedMode: opts.state.mode });
  const approveLevel = resolveApproveLevel({
    mode,
    configApprove: config.workflow.approve,
    legacyAutoFlag:
      config.workflow.autoApproveSpec === true && config.workflow.autoApprovePlan === true,
    savedApprove: opts.state.approve,
  });

  let state = opts.state;
  if (state.mode !== mode || state.approve !== approveLevel) {
    state = { ...state, mode, approve: approveLevel };
    saveState({ projectDir, sessionId }, state);
  }

  if (
    (mode === 'instant' || mode === 'quick') &&
    approveLevel !== 'none' &&
    approveLevel !== 'default'
  ) {
    wctx.bus.publish({
      type: 'warning',
      ts: Date.now(),
      phase: state.phase,
      message: `approve level "${approveLevel}" has no effect in ${mode} mode`,
    });
  }

  const advisory = adviseMode(opts.feature, mode);
  if (advisory.kind !== 'none') {
    wctx.bus.publish({
      type: 'mode_advice',
      ts: Date.now(),
      phase: opts.state.phase,
      kind: advisory.kind,
      risk: advisory.risk,
      currentMode: advisory.currentMode,
      suggestedMode: advisory.suggestedMode,
      confidence: advisory.confidence,
      factors: advisory.factors,
      missing: advisory.missing,
    });
    if (advisory.kind === 'downgrade') {
      wctx.bus.publish({
        type: 'mode_downgrade_advised',
        ts: Date.now(),
        phase: opts.state.phase,
        currentMode: advisory.currentMode,
        suggestedMode: advisory.suggestedMode,
      });
    }
  }

  wctx.bus.publish({
    type: 'mode_resolved',
    ts: Date.now(),
    phase: opts.state.phase,
    mode,
    approve: approveLevel,
  });

  const codebaseContext =
    config.codebase?.enabled !== false
      ? await buildRepoMap(projectDir, {
          featureText: opts.feature,
          tokenBudget: config.codebase?.tokenBudget ?? 4000,
          onWarn: (message) =>
            wctx.bus.publish({ type: 'warning', ts: Date.now(), phase: state.phase, message }),
          ...(config.codebase?.cacheDir !== undefined && { cacheDir: config.codebase.cacheDir }),
          ...(config.codebase?.include && { include: config.codebase.include }),
          ...(config.codebase?.exclude && { exclude: config.codebase.exclude }),
        })
      : undefined;

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
