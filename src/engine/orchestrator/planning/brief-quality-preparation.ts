import type { BriefQualityReport } from '../../spec/brief-quality.js';
import { evaluateBriefQuality, isBriefQualityCode } from '../../spec/brief-quality.js';
import type { TaskId } from '../../../core/schemas/task.js';
import { TaskIdSchema, taskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { PhaseRecoveryBinding } from '../run/phases.js';
import type { PlanningPhaseResult } from './types.js';
import { prepareLegacyBriefQuality } from './brief-quality-legacy.js';
import { recoveryViewOf } from './brief-owner-projection.js';
import { commitQueueMessagesDrained } from '../queue/drain.js';
import type {
  BriefRecoveryInspection,
  BriefRecoveryProjectionV1,
} from '../../../core/schemas/brief-recovery/document.js';
import type { QueueBriefInput } from '../../../core/schemas/brief-recovery.js';
import type {
  BriefQualityControllerResult,
  BriefQualityPreparationError,
  BriefQualityPreparationOptions,
  BriefQualityPreparationResult,
  BriefQualityRecoveryBinding,
} from './brief-quality-queue.js';
import {
  fallbackBriefRecoveryProjection,
  prepareQueuedTasks,
  releasePromptMessages,
} from './brief-quality-queue.js';

/**
 * The parked planning result every phase returns when it stops on a persisted
 * handoff: the owner's live projection when a recovery binding is bound, and
 * the storage-blocked fallback when the producer runs without one.
 */
export function parkedResult(
  input: Readonly<{
    recovery: PhaseRecoveryBinding | undefined;
    sessionId: string;
    state: WorkflowState;
  }>,
): PlanningPhaseResult {
  return {
    disposition: 'parked',
    state: input.state,
    projection:
      input.recovery?.projection ?? fallbackBriefRecoveryProjection(input.sessionId, input.state),
  };
}

function inspectionFor(sessionId: string, state: WorkflowState): BriefRecoveryInspection {
  return { sessionId, state: recoveryViewOf(state), now: new Date().toISOString() };
}

function inspectProjection(
  binding: BriefQualityRecoveryBinding | undefined,
  opts: BriefQualityPreparationOptions,
): BriefRecoveryProjectionV1 {
  if (binding === undefined) return fallbackBriefRecoveryProjection(opts.sessionId, opts.state);
  return binding.controller.inspectBriefRecovery(inspectionFor(opts.sessionId, opts.state));
}

function legacyTaskId(value: string | null): TaskId {
  const parsed = TaskIdSchema.safeParse(value ?? 'T000');
  return parsed.success ? parsed.data : taskId('T000');
}

export function briefQualityReportFromProjection(
  projection: BriefRecoveryProjectionV1,
): BriefQualityReport {
  const issues: BriefQualityReport['issues'] = [];
  for (const issue of projection.matchingReport?.issues ?? []) {
    if (!isBriefQualityCode(issue.code)) continue;
    issues.push({
      taskId: legacyTaskId(issue.taskId),
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
    });
  }
  return {
    version: 1,
    passed: projection.status === 'ready',
    score: projection.status === 'ready' ? 1 : 0,
    issues,
  };
}

function errorForProjection(projection: BriefRecoveryProjectionV1): BriefQualityPreparationError {
  const issue = projection.matchingReport?.issues.find(
    (candidate) => candidate.severity === 'error',
  );
  const blockerCode =
    projection.blocker?.kind === 'provider' ||
    projection.blocker?.kind === 'budget' ||
    projection.blocker?.kind === 'no-progress' ||
    projection.blocker?.kind === 'storage'
      ? projection.blocker.code
      : 'brief_contract_blocked';
  return {
    kind: 'brief-recovery-blocked',
    data: {
      code: issue?.code ?? blockerCode,
      taskId: issue?.taskId ?? 'unknown',
    },
  };
}

function queueInputsFor(
  opts: BriefQualityPreparationOptions,
  projection: BriefRecoveryProjectionV1,
): readonly QueueBriefInput[] {
  const messages = opts.queuedMessages ?? [];
  const { epochId, activeBrief } = projection;
  if (messages.length === 0 || epochId === null || activeBrief === null) {
    return [];
  }
  const operationId = projection.activeOperation?.operationId ?? null;
  return messages.map((message, index) => ({
    sessionId: opts.sessionId,
    epochId,
    inputId: message.id,
    sequence: projection.queuedInputs.count + index + 1,
    kind: 'feedback',
    source: 'typed',
    payload: message.text,
    base: activeBrief,
    operationId,
  }));
}

async function admitAndQueue(
  opts: BriefQualityPreparationOptions,
  binding: BriefQualityRecoveryBinding,
): Promise<{
  projection: BriefRecoveryProjectionV1;
  recovery: BriefQualityControllerResult;
}> {
  const admission = binding.createAdmissionInput({
    tasks: opts.tasks,
    state: opts.state,
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
  });
  let recovery: BriefQualityControllerResult = await binding.controller.enterBriefAdmission(
    admission,
    binding.authority,
  );
  let projection = recovery.projection;

  for (const input of queueInputsFor(opts, projection)) {
    const queued = await binding.controller.queueBriefInput(input, binding.authority);
    recovery = queued;
    projection = queued.projection;
    if (queued.kind === 'conflict' || queued.kind === 'refused') break;
  }
  return { projection, recovery };
}

function publishQualityEvent(
  opts: Pick<BriefQualityPreparationOptions, 'bus'> & { phase: WorkflowState['phase'] },
  report: Pick<BriefQualityReport, 'passed' | 'score'> & {
    issues: ReadonlyArray<{ severity: 'error' | 'warning' }>;
  },
): void {
  const errorCount = report.issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = report.issues.filter((issue) => issue.severity === 'warning').length;
  if (report.passed) {
    opts.bus.publish({
      type: 'brief_quality_passed',
      ts: Date.now(),
      phase: opts.phase,
      score: report.score,
      warningCount,
    });
  } else {
    opts.bus.publish({
      type: 'brief_quality_failed',
      ts: Date.now(),
      phase: opts.phase,
      score: report.score,
      errorCount,
      warningCount,
    });
  }
}

function settledQualityAttemptChanged(
  before: BriefRecoveryProjectionV1,
  after: BriefRecoveryProjectionV1,
): boolean {
  const latest = after.latestAttempt;
  return (
    latest !== null &&
    latest.status === 'settled' &&
    (latest.outcome === 'quality-failed' || latest.outcome === 'ready') &&
    after.matchingReport !== null &&
    latest.operationId !== before.latestAttempt?.operationId
  );
}

export async function prepareBriefQuality(
  opts: BriefQualityPreparationOptions,
): Promise<BriefQualityPreparationResult> {
  if (opts.recovery === undefined) return prepareLegacyBriefQuality(opts);
  const queued = await prepareQueuedTasks(opts);
  const prepared = {
    ...opts,
    state: queued.state,
    tasks: queued.tasks,
    queuedMessages: [],
  } satisfies BriefQualityPreparationOptions;
  const initialProjection = inspectProjection(opts.recovery, prepared);
  const initialQuality = evaluateBriefQuality(queued.tasks);
  publishQualityEvent({ bus: opts.bus, phase: queued.state.phase }, initialQuality);

  let admitted: Awaited<ReturnType<typeof admitAndQueue>>;
  try {
    admitted = await admitAndQueue(prepared, opts.recovery);
  } catch (err) {
    releasePromptMessages(opts, queued.messages);
    throw err;
  }
  const report = briefQualityReportFromProjection(admitted.projection);
  if (settledQualityAttemptChanged(initialProjection, admitted.projection)) {
    const matching = admitted.projection.matchingReport;
    if (matching !== null) {
      publishQualityEvent(
        { bus: opts.bus, phase: queued.state.phase },
        {
          passed: admitted.projection.status === 'ready',
          score: admitted.projection.status === 'ready' ? 1 : 0,
          issues: [...matching.issues],
        },
      );
    }
  }
  if (admitted.projection.status === 'ready') {
    let state = queued.state;
    try {
      if (queued.messages.length > 0) {
        state = commitQueueMessagesDrained({
          projectDir: opts.projectDir,
          sessionId: opts.sessionId,
          state,
          messages: queued.messages,
          bus: opts.bus,
        }).state;
      }
    } finally {
      releasePromptMessages(opts, queued.messages);
    }
    return {
      ok: true,
      state,
      tasks: queued.tasks,
      report,
      projection: admitted.projection,
      recovery: admitted.recovery,
    };
  }
  releasePromptMessages(opts, queued.messages);
  return {
    ok: false,
    state: queued.state,
    tasks: queued.tasks,
    report,
    projection: admitted.projection,
    recovery: admitted.recovery,
    error: errorForProjection(admitted.projection),
  };
}
