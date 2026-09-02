import { briefErrorMessages, firstBriefError } from '../../spec/brief-quality.js';
import { createBusTextHandler } from '../events.js';
import { planningError } from './errors.js';
import { buildBriefQualityRepairComment } from './regen-targeted.js';
import { regenerateTasks } from './regen.js';
import { runLegacyQualityGate } from './brief-quality-gate.js';
import { commitQueueMessagesDrained } from '../queue/drain.js';
import type {
  BriefQualityPreparationOptions,
  BriefQualityPreparationResult,
} from './brief-quality-queue.js';
import {
  fallbackBriefRecoveryProjection,
  prepareQueuedTasks,
  releasePromptMessages,
} from './brief-quality-queue.js';

export async function prepareLegacyBriefQuality(
  opts: BriefQualityPreparationOptions,
): Promise<BriefQualityPreparationResult> {
  const queued = await prepareQueuedTasks(opts);
  let state = queued.state;
  let tasks = queued.tasks;
  const queuedMessages = queued.messages;

  const first = runLegacyQualityGate({
    tasks,
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    bus: opts.bus,
    phase: state.phase,
  });
  if (first.ok) {
    const nextState =
      queuedMessages.length === 0
        ? state
        : commitQueueMessagesDrained({
            projectDir: opts.projectDir,
            sessionId: opts.sessionId,
            state,
            messages: queuedMessages,
            bus: opts.bus,
          }).state;
    return {
      ok: true,
      state: nextState,
      tasks,
      report: first.report,
      projection: fallbackBriefRecoveryProjection(opts.sessionId, nextState),
      recovery: null,
    };
  }

  const summary = 'regenerating Task Briefs to clear the brief quality gate';
  createBusTextHandler({ bus: opts.bus, phase: opts.state.phase })(`\n[${summary}]\n`);

  let regenerated: Awaited<ReturnType<typeof regenerateTasks>>;
  try {
    regenerated = await regenerateTasks({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      planner: opts.planner,
      callbacks: opts.callbacks,
      bus: opts.bus,
      state,
      metadata: opts.metadata,
      signal: opts.signal,
      feedback: buildBriefQualityRepairComment(briefErrorMessages(first.report)),
      queuedMessages,
      commitQueue: false,
      statusPhase: 'planning',
      statusSummary: summary,
      sinks: opts.sinks,
    });
  } catch (err) {
    releasePromptMessages(opts, queuedMessages);
    throw err;
  }

  state = regenerated.state;
  tasks = regenerated.tasks;
  const second = runLegacyQualityGate({
    tasks,
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    bus: opts.bus,
    phase: state.phase,
  });
  if (second.ok) {
    const nextState =
      regenerated.queuedMessages.length === 0
        ? state
        : commitQueueMessagesDrained({
            projectDir: opts.projectDir,
            sessionId: opts.sessionId,
            state,
            messages: regenerated.queuedMessages,
            bus: opts.bus,
          }).state;
    return {
      ok: true,
      state: nextState,
      tasks,
      report: second.report,
      projection: fallbackBriefRecoveryProjection(opts.sessionId, nextState),
      recovery: null,
    };
  }

  const secondError = firstBriefError(second.report);
  createBusTextHandler({ bus: opts.bus, phase: state.phase })(
    `\n[Brief quality gate still failing after regeneration: ${secondError?.message ?? 'unknown error'}]\n`,
  );
  releasePromptMessages(opts, regenerated.queuedMessages);

  return {
    ok: false,
    state,
    tasks,
    report: second.report,
    projection: fallbackBriefRecoveryProjection(opts.sessionId, state),
    recovery: null,
    error: planningError.briefQualityGateFailed(
      secondError?.code ?? 'unknown',
      String(secondError?.taskId ?? 'unknown'),
    ),
  };
}
