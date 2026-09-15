import { buildRepoMap } from '../../codebase/repomap.js';
import { formatTasks } from '../../spec/formatter.js';
import {
  resolveMode,
  resolveApproveLevel,
  blocksBriefsGate,
} from '../../../core/config/runtime/resolve.js';
import { runPlanningSteps } from './steps.js';
import { runRewindPlanning } from './rewind.js';
import { adviseMode, advisePlanSize } from './mode-advisor.js';
import { runBriefQualityWithRepair } from './brief-quality-gate.js';
import { runBriefsApprovalLoop } from './briefs-approval-loop.js';
import type { PlanningPhaseOptions, PlanningPhaseResult, PlanningProducerResult } from './types.js';
import { writeAndPublishArtifacts } from '../artifact-write.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import { publishWarning } from '../events.js';
import { firstBriefError } from '../../spec/brief-quality.js';
import { buildBriefQualityUnrepairedRecoveryIssue } from '../recovery/builders/planner.js';
import { assertNever } from '../../../utils/type-guards.js';
import { nowIso } from '../../../utils/format-time.js';
import { taskFiles } from '../../../core/schemas/task.js';

export async function runPlanningPhase(opts: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const { wctx } = opts;
  const { projectDir, config } = wctx;
  const mode = resolveMode({ config, savedMode: opts.state.mode });
  const approveLevel = resolveApproveLevel({
    mode,
    configApprove: config.workflow.approve,
    savedApprove: opts.state.approve,
  });

  let state = opts.state;
  if (state.mode !== mode || state.approve !== approveLevel) {
    state = { ...state, mode, approve: approveLevel };
  }

  if (mode === 'quick' && approveLevel !== 'none' && approveLevel !== 'default') {
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      message: `approve level "${approveLevel}" has no effect in ${mode} mode`,
      safety: { category: 'workflow', code: 'approve_ignored_for_mode' },
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
    ...(advisory.risk === 'trivial' ? { trivial: true } : {}),
  };

  const rewindPending = optsWithContext.rewindPending;
  const produced: PlanningProducerResult = rewindPending
    ? await runRewindPlanning(optsWithContext, rewindPending)
    : await runPlanningSteps(optsWithContext);
  if (produced.disposition === 'terminal') return produced;

  const { planner } = opts;
  const { sessionId, callbacks, bus, metadata, signal, sinks, modelCache, detectedContextLength } =
    wctx;
  const quality = await runBriefQualityWithRepair({
    tasks: [...produced.tasks],
    state: produced.state,
    planner,
    projectDir,
    sessionId,
    callbacks,
    bus,
    metadata,
    maxRetries: config.workflow.maxRetries,
    ...(signal === undefined ? {} : { signal }),
    ...(sinks === undefined ? {} : { sinks }),
  });
  state = quality.state;
  const tasks = quality.tasks;

  const planAdvice = advisePlanSize(
    { files: new Set(tasks.flatMap((task) => taskFiles(task))).size, briefs: tasks.length },
    mode,
  );
  if (planAdvice.kind !== 'none') {
    bus.publish({
      type: 'mode_advice',
      ts: Date.now(),
      phase: state.phase,
      kind: planAdvice.kind,
      risk: advisory.risk,
      currentMode: mode,
      suggestedMode: planAdvice.suggestedMode,
      confidence: 1,
      factors: planAdvice.factors,
      missing: [],
    });
  }

  writeAndPublishArtifacts({
    projectDir,
    sessionId,
    bus,
    phase: state.phase,
    metadata,
    items: [{ kind: 'task-briefs', text: formatTasks(tasks) }],
  });

  if (blocksBriefsGate(mode, approveLevel)) {
    const loop = await runBriefsApprovalLoop({
      tasks,
      state,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus,
      config,
      metadata,
      ...(signal === undefined ? {} : { signal }),
      ...(sinks === undefined ? {} : { sinks }),
      ...(modelCache === undefined ? {} : { modelCache }),
      ...(detectedContextLength === undefined ? {} : { detectedContextLength }),
    });
    switch (loop.outcome) {
      case 'accepted':
        return { disposition: 'ready-for-tasks', state: loop.state, tasks: loop.tasks };
      case 'closed':
        return { disposition: 'terminal', state: loop.state, outcome: 'closed' };
      case 'halted':
        return { disposition: 'terminal', state: loop.state, outcome: 'halted' };
      case 'aborted':
        return { disposition: 'terminal', state: loop.state, outcome: 'cancelled' };
      case 'failed':
        return { disposition: 'terminal', state: loop.state, outcome: 'failed' };
      default:
        return assertNever(loop.outcome);
    }
  }

  if (!quality.report.passed) {
    const firstError = firstBriefError(quality.report);
    const issue = buildBriefQualityUnrepairedRecoveryIssue({
      phase: state.phase,
      message: `Task Brief quality gate failed: ${firstError?.code ?? 'unknown'} in ${firstError?.taskId ?? 'unknown'}`,
      details: ['The repair pass could not fix it and no briefs gate is configured to review it.'],
      createdAt: nowIso(),
    });
    return {
      disposition: 'terminal',
      state: raisePendingRecovery({ projectDir, sessionId, bus }, state, issue),
      outcome: 'halted',
    };
  }

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BRIEF_ADMISSION_OPENED' });
  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'BEGIN_IMPLEMENTATION' });
  return { disposition: 'ready-for-tasks', state, tasks };
}
