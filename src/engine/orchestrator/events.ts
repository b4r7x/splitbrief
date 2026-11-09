import {
  type ConsultRecord,
  fixCyclesOf,
  type SeatWait,
  type WorkflowState,
} from '../../core/schemas/workflow.js';
import type { Check, CheckResult, CheckStatus, Task, TaskId } from '../../core/schemas/task.js';
import type {
  RecoveryAction,
  TaskCompletionMethod,
  CurrentCodeContextMode,
  TaskContextFit,
  RunnerKind,
  Phase,
} from '../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import type { ConsultReason } from '../../core/schemas/consult.js';
import type { AnsweredQuestion, ClarificationQuestion } from '../../core/schemas/question.js';
import type { AttachedInput } from '../../core/schemas/attachment.js';
import type { PlannerCall, StepRef } from '../../core/schemas/run-step.js';
import type { CrewSeatId } from '../../core/crew/identity.js';
import type { PlannerTierRole } from '../../core/runners/seat-roles.js';
import type { SeatIdentity } from '../../core/providers/seat-identity.js';
import type { EngineEvent, EngineEventOf, EventBus, TextChunkMarks } from '../events/types.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { Implementer, ImplementerPublisher } from '../implementers/types.js';
import { formatRecoveryHeadlineSpans } from '../../core/recovery/headline.js';
import { formatResumeCommand } from '../../core/recovery/resume-command.js';
import { BASE_SPLIT_NAMED } from '../../core/review/base-split.js';
import { labelError } from '../../utils/format-errors.js';
import { redactSecrets } from '../../utils/redact.js';
import { projectRunnerCallEvents } from '../calls/event-projection.js';
import type { RunnerCallEvent } from '../calls/types.js';
import type { RejectRunSnapshotResult } from '../../core/runtime/commands/types.js';
import { runRejectFacts } from '../../core/runtime/commands/messages.js';
import { admitUsageLimitWarning } from './usage-limit-gate.js';

type BusContext = {
  bus: EventBus;
  phase: Phase;
};

interface OperationalMessageSafety {
  readonly category: string;
  readonly code: string;
}

interface PublishOperationalMessageOptions extends BusContext {
  message: string;
  taskId?: TaskId | undefined;
  safety?: OperationalMessageSafety | undefined;
  /** An error's usage-limit reset, as the halt's `resetAt` names it; the row spells it when read. */
  resetAt?: string | undefined;
  /** The files a put-back of the running brief still acts on, on a revert, restore or denial row. */
  briefKept?: number | undefined;
}

type PlannerTextOptions = Pick<Partial<EngineEventOf<'planner_text'>>, 'role' | 'content'>;

let runnerCallEventSequence = 0;

export function publishRunnerCallEvent(
  ctx: BusContext & { rootDir: string; taskId?: TaskId | undefined },
  event: RunnerCallEvent,
): void {
  if (!admitUsageLimitWarning(ctx.bus, event)) return;
  const projected = projectRunnerCallEvents(event, {
    phase: ctx.phase,
    rootDir: ctx.rootDir,
    ...(ctx.taskId !== undefined && { taskId: ctx.taskId }),
    sequence: runnerCallEventSequence,
  });
  runnerCallEventSequence += 1;
  for (const projectedEvent of projected) ctx.bus.publish(projectedEvent);
}

export function createBusTextHandler(
  ctx: BusContext,
  options: PlannerTextOptions = {},
): (text: string, marks?: TextChunkMarks) => void {
  const { role, content } = options;
  return (text, marks) =>
    ctx.bus.publish({
      type: 'planner_text',
      ts: Date.now(),
      phase: ctx.phase,
      text,
      ...(role !== undefined && { role }),
      ...(content !== undefined && { content }),
      ...(marks?.messageStart === true && { messageStart: true }),
      ...(marks?.continues === true && { continues: true }),
      ...(marks?.subagent === true && { subagent: true }),
    });
}

export function createImplementerTextHandler(ctx: BusContext, implementer: Implementer) {
  const writesDirectly = implementer.capabilities?.writesFiles === 'direct';
  const handler = createBusTextHandler(ctx, {
    role: 'implementer',
    content: writesDirectly ? 'markdown' : 'plain',
  });
  return (text: string, marks?: TextChunkMarks) =>
    handler(text, { ...marks, messageStart: writesDirectly && marks?.messageStart === true });
}

export function publishPlannerStatus(
  bus: EventBus,
  state: WorkflowState,
  status: 'running' | 'done',
  extra?: {
    duration?: number;
    summary?: string;
    tool?: string;
    model?: string;
    call?: PlannerCall;
  },
): void {
  const tool = extra?.tool ?? state.plannerTool;
  // A named tool brings its own model, or none: the planner's never stands in for another seat's.
  const model = extra?.tool === undefined ? (extra?.model ?? state.plannerModel) : extra.model;
  bus.publish({
    type: 'planner_status',
    ts: Date.now(),
    phase: state.phase,
    status,
    ...(extra?.duration !== undefined && { duration: extra.duration }),
    ...(extra?.summary !== undefined && { summary: extra.summary }),
    ...(tool !== undefined && { tool }),
    ...(model !== undefined && { model }),
    ...(extra?.call !== undefined && { call: extra.call }),
  });
}

export function publishReviewEvent(
  ctx: BusContext,
  event: Pick<
    EngineEventOf<'review_started'>,
    'scope' | 'afterTaskId' | 'tool' | 'model' | 'axes'
  > &
    (
      | { type: 'review_started' }
      | Pick<
          EngineEventOf<'review_completed'>,
          'type' | 'verdict' | 'findings' | 'blockingFindings' | 'setAside' | 'duration'
        >
    ),
): void {
  ctx.bus.publish({ ...event, ts: Date.now(), phase: ctx.phase });
}

/** The fix cycles so far that ran a fix brief: the count the user reads. */
export function publishFixCycleStarted(
  bus: EventBus,
  state: WorkflowState,
  taskIds: readonly TaskId[],
): void {
  bus.publish({
    type: 'review_fix_started',
    ts: Date.now(),
    phase: state.phase,
    cycle: fixCyclesOf(state).briefed,
    taskIds: [...taskIds],
  });
}

// Announces the current ordered task list at loop entry and after structural changes.
// `task_started` stays the per-task lifecycle signal.
export function publishTasksPlanned(
  ctx: BusContext,
  tasks: readonly Pick<Task, 'id' | 'title' | 'suggestedFiles' | 'action'>[],
): void {
  ctx.bus.publish({
    type: 'tasks_planned',
    ts: Date.now(),
    phase: ctx.phase,
    tasks: tasks.map((task, index) => ({
      id: task.id,
      title: task.title,
      index,
      file: task.suggestedFiles[0],
      action: task.action,
    })),
    total: tasks.length,
  });
}

export function publishTaskStart(
  ctx: BusContext,
  opts: {
    taskId: TaskId;
    title: string;
    index: number;
    total: number;
    lineageAttempt: number;
    file: string;
    files?: string[];
    action: 'create' | 'modify';
    tool?: string;
    model?: string;
    axes?: readonly string[];
    backendKind?: RunnerKind;
    implementerProfile?: string;
    contextFit?: TaskContextFit;
    estimatedTokens?: number;
    untruncatedEstimatedTokens?: number;
    contextLength?: number;
    currentCodeTruncated?: boolean;
    currentCodeContextMode?: CurrentCodeContextMode;
    routingReason?: string;
  },
): void {
  ctx.bus.publish({ type: 'task_started', ts: Date.now(), phase: ctx.phase, ...opts });
}

export function publishTaskSkipped(
  ctx: BusContext,
  opts: { taskId: TaskId; title: string; reason: string },
): void {
  ctx.bus.publish({ type: 'task_skipped', ts: Date.now(), phase: ctx.phase, ...opts });
}

export function publishTaskComplete(
  ctx: BusContext,
  opts: {
    taskId: TaskId;
    title: string;
    method: TaskCompletionMethod;
    retries: number;
    duration: number;
    tool?: string;
    model?: string;
    implementerProfile?: string;
  },
): void {
  ctx.bus.publish({ type: 'task_completed', ts: Date.now(), phase: ctx.phase, ...opts });
}

export function publishReviewChecks(ctx: BusContext, status: 'off' | 'none'): void {
  ctx.bus.publish({ type: 'review_checks', ts: Date.now(), phase: ctx.phase, status });
}

export function publishReviewCheck(
  ctx: BusContext,
  opts: {
    status: 'running' | 'done' | 'not-run' | 'refused' | 'stopped' | 'off';
    id: string;
    taskId?: TaskId | undefined;
    command: string;
    moment: 'pre-review' | 'base' | 'brief' | 'plan' | 'verify';
    scenario?: string | undefined;
    waitsOnBase?: true | undefined;
    passed?: boolean | undefined;
    newFailures?: number | undefined;
    preExisting?: number | undefined;
    notVerified?: number | undefined;
    newKeys?: readonly string[] | undefined;
    preExistingKeys?: readonly string[] | undefined;
    own?: number | undefined;
    ownLeft?: number | undefined;
    deferred?: number | undefined;
    deferredTo?: readonly string[] | undefined;
    others?: number | undefined;
    detail?: string | undefined;
    duration?: number | undefined;
    reusedAt?: string | undefined;
    timedOut?: true | undefined;
  },
): void {
  ctx.bus.publish({
    type: 'full_suite',
    ts: Date.now(),
    phase: ctx.phase,
    status: opts.status,
    id: opts.id,
    ...(opts.taskId !== undefined && { taskId: opts.taskId }),
    command: opts.command,
    moment: opts.moment,
    ...(opts.scenario !== undefined && { scenario: opts.scenario }),
    ...(opts.waitsOnBase !== undefined && { waitsOnBase: opts.waitsOnBase }),
    ...(opts.passed !== undefined && { passed: opts.passed }),
    ...(opts.newFailures !== undefined && { newFailures: opts.newFailures }),
    ...(opts.preExisting !== undefined && { preExisting: opts.preExisting }),
    ...(opts.notVerified !== undefined && { notVerified: opts.notVerified }),
    ...(opts.newKeys !== undefined &&
      opts.newKeys.length > 0 && { newKeys: opts.newKeys.slice(0, BASE_SPLIT_NAMED) }),
    ...(opts.preExistingKeys !== undefined &&
      opts.preExistingKeys.length > 0 && {
        preExistingKeys: opts.preExistingKeys.slice(0, BASE_SPLIT_NAMED),
      }),
    ...(opts.own !== undefined && { own: opts.own }),
    ...(opts.ownLeft !== undefined && { ownLeft: opts.ownLeft }),
    ...(opts.deferred !== undefined && { deferred: opts.deferred }),
    ...(opts.deferredTo !== undefined && { deferredTo: [...opts.deferredTo] }),
    ...(opts.others !== undefined && { others: opts.others }),
    ...(opts.detail !== undefined && { detail: opts.detail }),
    ...(opts.duration !== undefined && { duration: opts.duration }),
    ...(opts.reusedAt !== undefined && { reusedAt: opts.reusedAt }),
    ...(opts.timedOut !== undefined && { timedOut: opts.timedOut }),
  });
}

/** A plan check's row: its id and command, and the scenario a render check names. */
export function planCheckRow(id: string, command: string, check: Check | undefined) {
  return {
    id,
    command,
    moment: 'plan' as const,
    ...(check?.kind === 'render' && { scenario: check.value }),
  };
}

/** How the row of a check that did not run settles: refused, or not run, with the reason. */
export function unranCheckRow(run: { status: CheckStatus; output: string }) {
  return {
    status: run.status === 'refused' ? ('refused' as const) : ('not-run' as const),
    detail: run.output,
  };
}

export function publishConsultAnswered(
  ctx: BusContext,
  opts: {
    taskId: TaskId;
    reason: ConsultReason;
    action: ConsultRecord['action'];
    diagnosis: string;
    newTaskIds: readonly TaskId[] | null;
    revision?: number | undefined;
    checkIds?: readonly string[] | undefined;
    note?: string | undefined;
  },
): void {
  ctx.bus.publish({
    type: 'consult_answered',
    ts: Date.now(),
    phase: ctx.phase,
    taskId: opts.taskId,
    reason: opts.reason,
    action: opts.action,
    diagnosis: opts.diagnosis,
    newTaskIds: opts.newTaskIds === null ? null : [...opts.newTaskIds],
    ...(opts.revision !== undefined && { revision: opts.revision }),
    ...(opts.checkIds !== undefined && { checkIds: [...opts.checkIds] }),
    ...(opts.note !== undefined && { note: opts.note }),
  });
}

export function publishTaskReplaced(ctx: BusContext, taskId: TaskId, revision: number): void {
  ctx.bus.publish({ type: 'task_replaced', ts: Date.now(), phase: ctx.phase, taskId, revision });
}

export function publishTasksInserted(
  ctx: BusContext,
  parentId: TaskId,
  taskIds: readonly TaskId[],
): void {
  ctx.bus.publish({
    type: 'tasks_inserted',
    ts: Date.now(),
    phase: ctx.phase,
    parentId,
    taskIds: [...taskIds],
  });
}

export function publishTaskValidating(
  ctx: BusContext,
  taskId: TaskId,
  check?: { id: string; command: string; scenario?: string | undefined },
): void {
  ctx.bus.publish({
    type: 'task_validating',
    ts: Date.now(),
    phase: ctx.phase,
    taskId,
    ...(check !== undefined && {
      check: {
        id: check.id,
        command: check.command,
        ...(check.scenario !== undefined && { scenario: check.scenario }),
      },
    }),
  });
}

export function publishRunRejected(
  bus: EventBus,
  result: Extract<RejectRunSnapshotResult, { status: 'rejected' }>,
): void {
  const facts = runRejectFacts(result);
  bus.publish({
    type: 'run_rejected',
    ts: Date.now(),
    restored: [...facts.restored],
    removed: [...facts.removed],
    conflicted: [...facts.conflicted],
    missing: facts.missing,
    ...(facts.savedTo !== undefined && { savedTo: facts.savedTo }),
  });
}

export function publishChecksRun(
  ctx: BusContext,
  taskId: TaskId,
  results: readonly CheckResult[],
): void {
  ctx.bus.publish({
    type: 'checks_run',
    ts: Date.now(),
    phase: ctx.phase,
    taskId,
    results: [...results],
  });
}

export function publishSeatWaitStarted(ctx: BusContext, wait: SeatWait, tool: string): void {
  ctx.bus.publish({
    type: 'seat_wait_started',
    ts: Date.now(),
    phase: ctx.phase,
    seat: wait.seat,
    resetAt: wait.resetAt,
    tool,
    wait,
  });
}

export function publishSeatWaitEnded(ctx: BusContext, seat: CrewSeatId, kept?: true): void {
  ctx.bus.publish({
    type: 'seat_wait_ended',
    ts: Date.now(),
    phase: ctx.phase,
    seat,
    ...(kept !== undefined && { kept }),
  });
}

export function publishSeatSwitched(
  ctx: BusContext,
  opts: Pick<
    EngineEventOf<'seat_switched'>,
    | 'switchId'
    | 'seat'
    | 'from'
    | 'to'
    | 'cause'
    | 'auto'
    | 'configRevision'
    | 'accountCause'
    | 'headline'
  >,
): void {
  ctx.bus.publish({ type: 'seat_switched', ts: Date.now(), phase: ctx.phase, ...opts });
}

export function publishSeatRetry(
  ctx: BusContext,
  opts: { seat: CrewSeatId; attempt: number; delayMs: number },
): void {
  ctx.bus.publish({ type: 'seat_retry', ts: Date.now(), phase: ctx.phase, ...opts });
}

/** A refused first answer that the seat is asked again for: no row, the reasons stay in the log. */
export function publishSeatAnswerRefused(
  ctx: BusContext,
  seat: PlannerTierRole,
  reasons: readonly string[],
): void {
  ctx.bus.publish({
    type: 'seat_answer_refused',
    ts: Date.now(),
    phase: ctx.phase,
    seat,
    reasons: [...reasons],
  });
}

export function publishNoProgressCut(
  ctx: BusContext,
  opts: { taskId: TaskId | null; seat: CrewSeatId; silentMs: number },
): void {
  ctx.bus.publish({ type: 'no_progress_cut', ts: Date.now(), phase: ctx.phase, ...opts });
}

export function publishCostUpdate(ctx: BusContext, tokenUsage: TokenUsage): void {
  ctx.bus.publish({ type: 'cost_update', ts: Date.now(), phase: ctx.phase, tokenUsage });
}

export function publishError(options: PublishOperationalMessageOptions): void {
  const { bus, phase, message, safety, resetAt, briefKept } = options;
  bus.publish({
    type: 'error',
    ts: Date.now(),
    phase,
    message,
    ...(safety !== undefined && {
      category: safety.category,
      code: safety.code,
    }),
    ...(resetAt !== undefined && { resetAt }),
    ...(briefKept !== undefined && { briefKept }),
  });
}

export function publishInfo(
  options: BusContext & { message: string; briefKept?: number | undefined },
): void {
  const { bus, phase, message, briefKept } = options;
  bus.publish({
    type: 'info',
    ts: Date.now(),
    phase,
    message,
    ...(briefKept !== undefined && { briefKept }),
  });
}

export function publishWarning(options: PublishOperationalMessageOptions): void {
  const { bus, phase, message, taskId, safety, briefKept } = options;
  bus.publish({
    type: 'warning',
    ts: Date.now(),
    phase,
    message,
    ...(taskId !== undefined && { taskId }),
    ...(safety !== undefined && {
      category: safety.category,
      code: safety.code,
    }),
    ...(briefKept !== undefined && { briefKept }),
  });
}

export function publishWarningFromError(ctx: BusContext, label: string, err: unknown): void {
  publishWarning({ ...ctx, message: labelError(label, err) });
}

export function publishUserMessage(
  ctx: BusContext,
  text: string,
  options: {
    qa?: AnsweredQuestion[];
    questions?: readonly ClarificationQuestion[];
    attachedInputs?: readonly AttachedInput[] | undefined;
  } = {},
): void {
  const { qa, questions, attachedInputs } = options;
  ctx.bus.publish({
    type: 'user_message',
    ts: Date.now(),
    phase: ctx.phase,
    text,
    ...(qa !== undefined && qa.length > 0 ? { qa } : {}),
    ...(questions !== undefined ? { questions: [...questions] } : {}),
    ...(attachedInputs !== undefined && attachedInputs.length > 0
      ? { attachedInputs: [...attachedInputs] }
      : {}),
  });
}

export function publishRecoveryPrompted(
  ctx: BusContext,
  sessionId: string,
  issue: RecoveryIssue,
  at: StepRef,
  reviewNone: boolean,
): void {
  const ts = Date.now();
  const headlineSpans = [...formatRecoveryHeadlineSpans(issue, ts)];
  ctx.bus.publish({
    type: 'recovery_prompted',
    ts,
    phase: ctx.phase,
    issueId: issue.id,
    reason: issue.reason,
    headline: headlineSpans.map((part) => part.text).join(''),
    headlineSpans,
    resumeCommand: formatResumeCommand(sessionId, issue, reviewNone),
    ...(issue.taskId !== undefined && { taskId: issue.taskId }),
    files: issue.files,
    affectedTaskIds: issue.affectedTaskIds,
    availableActions: issue.availableActions,
    recommendedAction: issue.recommendedAction,
    issue,
    at,
  });
}

type RecoveryOutcome = EngineEventOf<'recovery_resolved'>['outcome'];

type RecoveryEventSpec =
  | { kind: 'selected'; reviewNone: boolean }
  | { kind: 'failed'; message: string }
  | {
      kind: 'resolved';
      outcome: RecoveryOutcome;
      implementerProfile?: string | undefined;
    };

/** `phase` is the run's phase when the event is published; the issue keeps the halt's own. */
type RecoveryEventOpts = BusContext & {
  issue: RecoveryIssue;
  action: RecoveryAction;
};

function publishRecoveryEvent(
  { bus, phase, issue, action }: RecoveryEventOpts,
  spec: RecoveryEventSpec,
): void {
  // The seat the halt stopped: the one a swap would move, else the one the issue names.
  const seat = issue.switchSeat?.seat ?? issue.seat;
  const base = {
    ts: Date.now(),
    phase,
    issueId: issue.id,
    reason: issue.reason,
    action,
    ...(seat !== undefined && { seat }),
  } as const;
  if (spec.kind === 'selected') {
    bus.publish({
      type: 'recovery_action_selected',
      ...base,
      ...(spec.reviewNone && { reviewNone: true as const }),
    });
    return;
  }
  if (spec.kind === 'failed') {
    bus.publish({ type: 'recovery_action_failed', ...base, message: spec.message });
    return;
  }
  bus.publish({
    type: 'recovery_resolved',
    ...base,
    outcome: spec.outcome,
    ...(spec.implementerProfile !== undefined && { implementerProfile: spec.implementerProfile }),
  });
}

export function publishRecoveryActionSelected(
  opts: RecoveryEventOpts & { reviewNone?: boolean | undefined },
): void {
  publishRecoveryEvent(opts, { kind: 'selected', reviewNone: opts.reviewNone === true });
}

export function publishRecoveryActionFailed(opts: RecoveryEventOpts & { message: string }): void {
  publishRecoveryEvent(opts, { kind: 'failed', message: opts.message });
}

export function publishRecoveryResolved(
  opts: RecoveryEventOpts & {
    outcome: RecoveryOutcome;
    implementerProfile?: string | undefined;
  },
): void {
  publishRecoveryEvent(opts, {
    kind: 'resolved',
    outcome: opts.outcome,
    ...(opts.implementerProfile !== undefined && { implementerProfile: opts.implementerProfile }),
  });
}

/** The seats this run pass holds, complete, so the chrome names them until their change point. */
export function publishWorkflowConfig(
  ctx: BusContext,
  opts: SeatIdentity & { skills?: string[] | undefined },
): void {
  ctx.bus.publish({
    type: 'workflow_config',
    ts: Date.now(),
    phase: ctx.phase,
    plannerTool: opts.plannerTool,
    ...(opts.plannerModel !== undefined && { plannerModel: opts.plannerModel }),
    ...(opts.plannerKind !== undefined && { plannerKind: opts.plannerKind }),
    ...(opts.plannerAxes !== undefined && { plannerAxes: [...opts.plannerAxes] }),
    implementerTool: opts.implementerTool,
    ...(opts.implementerModel !== undefined && { implementerModel: opts.implementerModel }),
    ...(opts.implementerKind !== undefined && { implementerKind: opts.implementerKind }),
    ...(opts.implementerAxes !== undefined && { implementerAxes: [...opts.implementerAxes] }),
    ...(opts.reviewerTool !== undefined && { reviewerTool: opts.reviewerTool }),
    ...(opts.reviewerModel !== undefined && { reviewerModel: opts.reviewerModel }),
    ...(opts.reviewerKind !== undefined && { reviewerKind: opts.reviewerKind }),
    ...(opts.reviewerAxes !== undefined && { reviewerAxes: [...opts.reviewerAxes] }),
    ...(opts.reviewerSeat !== undefined && { reviewerSeat: opts.reviewerSeat }),
    ...(opts.skills !== undefined && { skills: opts.skills }),
  });
}

export function publishImplementerGenerateRunning(
  ctx: BusContext,
  opts: Omit<Parameters<ImplementerPublisher['publishRunning']>[0], 'phase'>,
): void {
  ctx.bus.publish({
    type: 'implementer_generate_running',
    ts: Date.now(),
    phase: ctx.phase,
    taskId: opts.taskId,
    ...(opts.file !== undefined && { file: opts.file }),
    ...(opts.lineageAttempt !== undefined && { lineageAttempt: opts.lineageAttempt }),
  });
}

export function publishImplementerGenerateDone(
  ctx: BusContext,
  opts: Omit<Parameters<ImplementerPublisher['publishDone']>[0], 'phase'>,
): void {
  const event: EngineEvent = {
    type: 'implementer_generate_done',
    ts: Date.now(),
    phase: ctx.phase,
    taskId: opts.taskId,
    file: opts.file,
    files: opts.files,
    ...(opts.linesAdded !== undefined && { linesAdded: opts.linesAdded }),
    ...(opts.linesRemoved !== undefined && { linesRemoved: opts.linesRemoved }),
    duration: opts.duration,
    ...(opts.noChange === true && { noChange: true }),
    ...(opts.kept !== undefined && opts.kept.length > 0 && { kept: [...opts.kept] }),
  };
  if (opts.diff !== undefined) event.diff = redactSecrets(opts.diff);
  ctx.bus.publish(event);
}

function publishImplementerGenerateFailed(
  ctx: BusContext,
  taskId: TaskId,
  model?: string,
  error?: string,
): void {
  ctx.bus.publish({
    type: 'implementer_generate_failed',
    ts: Date.now(),
    phase: ctx.phase,
    taskId,
    ...(model !== undefined && { model }),
    ...(error !== undefined && { error: redactSecrets(error) }),
  });
}

export function createImplementerPublisher(bus: EventBus): ImplementerPublisher {
  return {
    publishRunning: ({ phase, ...opts }) => publishImplementerGenerateRunning({ bus, phase }, opts),
    publishCallEvent: ({ phase, taskId, rootDir, event }) =>
      publishRunnerCallEvent({ bus, phase, taskId, rootDir }, event),
    publishDone: ({ phase, ...opts }) => publishImplementerGenerateDone({ bus, phase }, opts),
    publishFailed: ({ phase, taskId, model, error }) =>
      publishImplementerGenerateFailed({ bus, phase }, taskId, model, error),
    publishWarning: ({ phase, taskId, message, safety }) =>
      publishWarning({ bus, phase, taskId, message, safety }),
  };
}
