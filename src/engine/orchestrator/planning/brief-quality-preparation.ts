import type { BriefQualityReport } from '../../spec/brief-quality.js';
import {
  briefErrorMessages,
  evaluateBriefQuality,
  firstBriefError,
} from '../../spec/brief-quality.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import { TaskIdSchema, taskId } from '../../../core/schemas/task.js';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import type { EventBus } from '../../events/types.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import type { Planner } from '../../planners/types.js';
import type { PhaseRecoveryBinding } from '../run/phases.js';
import type { PlanningPhaseResult } from './types.js';
import { createBusTextHandler } from '../events.js';
import { planningError } from './errors.js';
import { buildBriefQualityRepairComment } from './regen-targeted.js';
import { regenerateTasks } from './regen.js';
import { runLegacyQualityGate } from './brief-quality-gate.js';
import { recoveryViewOf } from './brief-owner-projection.js';
import {
  commitQueueMessagesDrained,
  readQueueForPrompt,
  releaseQueueMessagesForPrompt,
} from '../queue/drain.js';
import type {
  BriefAdmissionInput,
  BriefRecoveryController,
  BriefRecoveryInspection,
  BriefRecoveryProjectionV1,
  QueueBriefInput,
  QueueResultV1,
  RecoveryResultV1,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';

type RecoveryControllerClient = Pick<
  BriefRecoveryController,
  | 'inspectBriefRecovery'
  | 'enterBriefAdmission'
  | 'queueBriefInput'
  | 'dispatchBriefAction'
  | 'settlePlannerAttempt'
>;

export type BriefQualityAdmissionContext = {
  tasks: Task[];
  state: WorkflowState;
  projectDir: string;
  sessionId: string;
};

export type BriefQualityRecoveryBinding = {
  controller: RecoveryControllerClient;
  authority: StateAuthorityReceipt;
  createAdmissionInput: (input: BriefQualityAdmissionContext) => BriefAdmissionInput;
  /** The workflow owner exposes the persisted state for terminal recovery decisions. */
  readState?: () => WorkflowState;
};

export type BriefQualityControllerResult = RecoveryResultV1 | QueueResultV1;

export type BriefQualityPreparationOptions = {
  tasks: Task[];
  state: WorkflowState;
  planner: Planner;
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  metadata: SpecMetadata;
  signal?: AbortSignal | undefined;
  sinks?: WorkflowSinks | undefined;
  queuedMessages?: readonly QueuedMessage[] | undefined;
  recovery?: BriefQualityRecoveryBinding | undefined;
};

export type BriefQualityPreparationError =
  | ReturnType<typeof planningError.briefQualityGateFailed>
  | {
      kind: 'brief-recovery-blocked';
      data: { code: string; taskId: string };
    };

export type BriefQualityPreparationResult =
  | {
      ok: true;
      state: WorkflowState;
      tasks: Task[];
      report: BriefQualityReport;
      projection: BriefRecoveryProjectionV1;
      recovery: BriefQualityControllerResult | null;
    }
  | {
      ok: false;
      state: WorkflowState;
      tasks: Task[];
      report: BriefQualityReport;
      projection: BriefRecoveryProjectionV1;
      recovery: BriefQualityControllerResult | null;
      error: BriefQualityPreparationError;
    };

const fallbackAllowedActions = [
  'status',
] satisfies readonly BriefRecoveryProjectionV1['allowedActions'][number][];

export function fallbackBriefRecoveryProjection(
  sessionId: string,
  state: WorkflowState,
): BriefRecoveryProjectionV1 {
  return {
    version: 1,
    sessionId,
    stateRevision: state.stateRevision ?? 0,
    recoveryRevision: 0,
    epochId: null,
    status: 'storage-blocked',
    origin: null,
    continuation: null,
    activeBrief: null,
    matchingReport: null,
    blocker: {
      kind: 'storage',
      code: 'brief_storage_invalid',
      message: 'Brief recovery controller is unavailable.',
    },
    allowedActions: fallbackAllowedActions,
    activeOperation: null,
    latestAttempt: null,
    queuedInputs: { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
  };
}

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

function legacyCode(code: string): BriefQualityReport['issues'][number]['code'] | null {
  switch (code) {
    case 'missing_scope':
    case 'missing_validation':
    case 'vague_validation':
    case 'missing_evidence':
    case 'missing_escalation':
    case 'missing_code_context':
    case 'empty_task_list':
    case 'multi_file_task':
    case 'missing_type_definitions':
    case 'missing_implementation_steps':
      return code;
    default:
      return null;
  }
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
    const code = legacyCode(issue.code);
    if (code === null) continue;
    issues.push({
      taskId: legacyTaskId(issue.taskId),
      severity: issue.severity,
      code,
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
  if (messages.length === 0 || projection.epochId === null || projection.activeBrief === null) {
    return [];
  }
  const operationId = projection.activeOperation?.operationId ?? null;
  return messages.map((message, index) => ({
    sessionId: opts.sessionId,
    epochId: projection.epochId ?? '',
    inputId: message.id,
    sequence: projection.queuedInputs.count + index + 1,
    kind: 'feedback',
    source: 'typed',
    payload: message.text,
    base: projection.activeBrief ?? { revision: 0, hash: '', path: '' },
    operationId,
  }));
}

type QueuedTasksPreparation = {
  state: WorkflowState;
  tasks: Task[];
  messages: readonly QueuedMessage[];
};

async function prepareQueuedTasks(
  opts: BriefQualityPreparationOptions,
): Promise<QueuedTasksPreparation> {
  const pending =
    opts.queuedMessages === undefined
      ? readQueueForPrompt({
          projectDir: opts.projectDir,
          sessionId: opts.sessionId,
          state: opts.state,
        })
      : { state: opts.state, messages: [...opts.queuedMessages] };
  if (pending.messages.length === 0) {
    return { state: pending.state, tasks: opts.tasks, messages: [] };
  }

  const summary = 'applying queued input before the brief quality gate';
  createBusTextHandler({ bus: opts.bus, phase: pending.state.phase })(`\n[${summary}]\n`);
  try {
    const regenerated = await regenerateTasks({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      planner: opts.planner,
      callbacks: opts.callbacks,
      bus: opts.bus,
      state: pending.state,
      metadata: opts.metadata,
      signal: opts.signal,
      queuedMessages: pending.messages,
      commitQueue: false,
      statusPhase: 'planning',
      statusSummary: summary,
      sinks: opts.sinks,
    });
    return {
      state: regenerated.state,
      tasks: regenerated.tasks,
      messages: regenerated.queuedMessages,
    };
  } catch (err) {
    releasePromptMessages(opts, pending.messages);
    throw err;
  }
}

async function admitAndQueue(
  opts: BriefQualityPreparationOptions,
  binding: BriefQualityRecoveryBinding,
  initialProjection: BriefRecoveryProjectionV1,
): Promise<{
  projection: BriefRecoveryProjectionV1;
  recovery: BriefQualityControllerResult | null;
}> {
  let projection = initialProjection;
  let recovery: BriefQualityControllerResult | null = null;
  const admission = binding.createAdmissionInput({
    tasks: opts.tasks,
    state: opts.state,
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
  });
  recovery = await binding.controller.enterBriefAdmission(admission, binding.authority);
  projection = recovery.projection;

  for (const input of queueInputsFor(opts, projection)) {
    const queued = await binding.controller.queueBriefInput(input, binding.authority);
    recovery = queued;
    projection = queued.projection;
    if (queued.kind === 'conflict' || queued.kind === 'refused') break;
  }
  return { projection, recovery };
}

async function prepareLegacyBriefQuality(
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

function releasePromptMessages(
  opts: BriefQualityPreparationOptions,
  messages: ReadonlyArray<{ id: string }>,
): void {
  releaseQueueMessagesForPrompt(
    { projectDir: opts.projectDir, sessionId: opts.sessionId },
    messages,
  );
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
    admitted = await admitAndQueue(prepared, opts.recovery, initialProjection);
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
