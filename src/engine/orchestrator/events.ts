import type { ConsultRecord, WorkflowState } from '../../core/schemas/workflow.js';
import type { CheckResult, Task, TaskId } from '../../core/schemas/task.js';
import type {
  RecoveryAction,
  TaskCompletionMethod,
  CurrentCodeContextMode,
  TaskContextFit,
  Phase,
  RecoveryReason,
} from '../../core/schemas/enums.js';
import type { RecoveryIssue, SeatSwapCandidate } from '../../core/schemas/recovery/schemas.js';
import type { ConsultReason, ConsultSeat } from '../../core/schemas/consult.js';
import type { AnsweredQuestion } from '../../core/schemas/question.js';
import type { AttachedInput } from '../../core/schemas/attachment.js';
import type { PlannerCall } from '../../core/schemas/run-step.js';
import type { CrewSeatId } from '../../core/crew/identity.js';
import type { EngineEvent, EngineEventOf, EventBus } from '../events/types.js';
import type { ReviewChecksPlan } from '../../core/schemas/review.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { ImplementerPublisher } from '../implementers/types.js';
import { formatRecoveryHeadline } from '../../core/recovery/headline.js';
import { formatResumeCommand } from '../../core/recovery/resume-command.js';
import { labelError } from '../../utils/format-errors.js';
import { redactSecrets } from '../../utils/redact.js';
import { projectRunnerCallEvents } from '../calls/event-projection.js';
import type { RunnerCallEvent } from '../calls/types.js';

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
  planCheck?: { code: string; message: string } | undefined;
}

type PlannerTextOptions = Pick<Partial<EngineEventOf<'planner_text'>>, 'role' | 'content'>;

let runnerCallEventSequence = 0;

export function publishRunnerCallEvent(
  ctx: BusContext & { rootDir: string; taskId?: TaskId | undefined },
  event: RunnerCallEvent,
): void {
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
): (text: string, opts?: { messageStart?: boolean | undefined }) => void {
  const { role, content } = options;
  return (text, opts) =>
    ctx.bus.publish({
      type: 'planner_text',
      ts: Date.now(),
      phase: ctx.phase,
      text,
      ...(role !== undefined && { role }),
      ...(content !== undefined && { content }),
      ...(opts?.messageStart === true && { messageStart: true }),
    });
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

// Announces the whole plan once, so consumers can show what is still coming instead of learning
// about each task only when it starts. `task_started` stays the per-task lifecycle signal.
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
    attemptAllowance: number;
    file: string;
    files?: string[];
    action: 'create' | 'modify';
    tool?: string;
    model?: string;
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

export function publishReviewChecksPlan(
  ctx: BusContext,
  opts:
    | { scope: 'final' | 'task'; status: 'off' }
    | { scope: 'final' | 'task'; status: 'planned'; plan: ReviewChecksPlan }
    | { scope: 'final' | 'task'; status: 'skipped'; plan: ReviewChecksPlan; reason: string },
): void {
  ctx.bus.publish({
    type: 'review_checks',
    ts: Date.now(),
    phase: ctx.phase,
    scope: opts.scope,
    status: opts.status,
    ...(opts.status === 'planned' && {
      commands: opts.plan.commands.map((command) => ({ ...command })),
      declined: opts.plan.declined.map((entry) => ({ ...entry })),
      reason: opts.plan.reason,
    }),
    ...(opts.status === 'skipped' && {
      commands: opts.plan.commands.map((command) => ({ ...command })),
      reason: opts.reason,
    }),
  });
}

export function publishReviewCheck(
  ctx: BusContext,
  opts: {
    status: 'running' | 'done' | 'not-run' | 'refused';
    id: string;
    command: string;
    moment: 'pre-review' | 'base' | 'brief' | 'plan';
    scenario?: string | undefined;
    passed?: boolean | undefined;
    newFailures?: number | undefined;
    preExisting?: number | undefined;
    notVerified?: number | undefined;
    own?: number | undefined;
    ownLeft?: number | undefined;
    others?: number | undefined;
    proven?: boolean | undefined;
    detail?: string | undefined;
    duration?: number | undefined;
  },
): void {
  ctx.bus.publish({
    type: 'full_suite',
    ts: Date.now(),
    phase: ctx.phase,
    status: opts.status,
    id: opts.id,
    command: opts.command,
    moment: opts.moment,
    ...(opts.scenario !== undefined && { scenario: opts.scenario }),
    ...(opts.passed !== undefined && { passed: opts.passed }),
    ...(opts.newFailures !== undefined && { newFailures: opts.newFailures }),
    ...(opts.preExisting !== undefined && { preExisting: opts.preExisting }),
    ...(opts.notVerified !== undefined && { notVerified: opts.notVerified }),
    ...(opts.own !== undefined && { own: opts.own }),
    ...(opts.ownLeft !== undefined && { ownLeft: opts.ownLeft }),
    ...(opts.others !== undefined && { others: opts.others }),
    ...(opts.proven !== undefined && { proven: opts.proven }),
    ...(opts.detail !== undefined && { detail: opts.detail }),
    ...(opts.duration !== undefined && { duration: opts.duration }),
  });
}

export function publishGitBranchCreated(ctx: BusContext, name: string): void {
  ctx.bus.publish({ type: 'git_branch_created', ts: Date.now(), phase: ctx.phase, name });
}

export function publishRetry(
  opts: BusContext & {
    taskId: TaskId;
    attempt: number;
    maxRetries: number;
    lineageAttempt: number;
    attemptAllowance: number;
    error: string;
  },
): void {
  opts.bus.publish({
    type: 'task_retry',
    ts: Date.now(),
    phase: opts.phase,
    taskId: opts.taskId,
    attempt: opts.attempt,
    maxRetries: opts.maxRetries,
    lineageAttempt: opts.lineageAttempt,
    attemptAllowance: opts.attemptAllowance,
    error: opts.error,
  });
}

export function publishConsultAnswered(
  ctx: BusContext,
  opts: {
    taskId: TaskId;
    reason: ConsultReason;
    seat: ConsultSeat;
    action: ConsultRecord['action'];
    diagnosis: string;
    newTaskIds: readonly TaskId[] | null;
    revision?: number | undefined;
    checkIds?: readonly string[] | undefined;
    decisionCount?: number | undefined;
  },
): void {
  ctx.bus.publish({
    type: 'consult_answered',
    ts: Date.now(),
    phase: ctx.phase,
    taskId: opts.taskId,
    reason: opts.reason,
    seat: opts.seat,
    action: opts.action,
    diagnosis: opts.diagnosis,
    newTaskIds: opts.newTaskIds === null ? null : [...opts.newTaskIds],
    ...(opts.revision !== undefined && { revision: opts.revision }),
    ...(opts.checkIds !== undefined && { checkIds: [...opts.checkIds] }),
    ...(opts.decisionCount !== undefined && { decisionCount: opts.decisionCount }),
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

export function publishSeatWaitStarted(ctx: BusContext, seat: CrewSeatId, resetAt: string): void {
  ctx.bus.publish({ type: 'seat_wait_started', ts: Date.now(), phase: ctx.phase, seat, resetAt });
}

export function publishSeatSwitched(
  ctx: BusContext,
  opts: {
    seat: CrewSeatId;
    from: SeatSwapCandidate;
    to: SeatSwapCandidate;
    cause: RecoveryReason;
    auto: boolean;
    configRevision: string;
  },
): void {
  ctx.bus.publish({ type: 'seat_switched', ts: Date.now(), phase: ctx.phase, ...opts });
}

export function publishSeatRetry(
  ctx: BusContext,
  opts: { seat: CrewSeatId; attempt: number; delayMs: number },
): void {
  ctx.bus.publish({ type: 'seat_retry', ts: Date.now(), phase: ctx.phase, ...opts });
}

export function publishNoProgressCut(
  ctx: BusContext,
  opts: { taskId: TaskId | null; seat: CrewSeatId; silentMs: number },
): void {
  ctx.bus.publish({ type: 'no_progress_cut', ts: Date.now(), phase: ctx.phase, ...opts });
}

export function publishConsultBoundSpent(ctx: BusContext): void {
  ctx.bus.publish({ type: 'consult_bound_spent', ts: Date.now(), phase: ctx.phase });
}

export function publishCostUpdate(ctx: BusContext, tokenUsage: TokenUsage): void {
  ctx.bus.publish({ type: 'cost_update', ts: Date.now(), phase: ctx.phase, tokenUsage });
}

export function publishError(options: PublishOperationalMessageOptions): void {
  const { bus, phase, message, safety, resetAt } = options;
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
  });
}

export function publishWarning(options: PublishOperationalMessageOptions): void {
  const { bus, phase, message, taskId, safety, planCheck } = options;
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
    ...(planCheck !== undefined && { planCheck }),
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
    attachedInputs?: readonly AttachedInput[] | undefined;
  } = {},
): void {
  const { qa, attachedInputs } = options;
  ctx.bus.publish({
    type: 'user_message',
    ts: Date.now(),
    phase: ctx.phase,
    text,
    ...(qa !== undefined && qa.length > 0 ? { qa } : {}),
    ...(attachedInputs !== undefined && attachedInputs.length > 0
      ? { attachedInputs: [...attachedInputs] }
      : {}),
  });
}

export function publishRecoveryPrompted(
  ctx: BusContext,
  sessionId: string,
  issue: RecoveryIssue,
): void {
  ctx.bus.publish({
    type: 'recovery_prompted',
    ts: Date.now(),
    phase: ctx.phase,
    issueId: issue.id,
    reason: issue.reason,
    headline: formatRecoveryHeadline(issue),
    resumeCommand: formatResumeCommand(sessionId, issue),
    ...(issue.taskId !== undefined && { taskId: issue.taskId }),
    files: issue.files,
    affectedTaskIds: issue.affectedTaskIds,
    availableActions: issue.availableActions,
    recommendedAction: issue.recommendedAction,
  });
}

type RecoveryOutcome = EngineEventOf<'recovery_resolved'>['outcome'];

type RecoveryEventSpec =
  | { kind: 'selected' }
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
    bus.publish({ type: 'recovery_action_selected', ...base });
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

export function publishRecoveryActionSelected(opts: RecoveryEventOpts): void {
  publishRecoveryEvent(opts, { kind: 'selected' });
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

export function publishWorkflowConfig(
  ctx: BusContext,
  opts: {
    plannerTool: string;
    plannerModel?: string | undefined;
    implementerTool: string;
    implementerModel?: string | undefined;
    reviewerTool?: string | undefined;
    reviewerModel?: string | undefined;
    skills?: string[] | undefined;
  },
): void {
  ctx.bus.publish({
    type: 'workflow_config',
    ts: Date.now(),
    phase: ctx.phase,
    plannerTool: opts.plannerTool,
    ...(opts.plannerModel !== undefined && { plannerModel: opts.plannerModel }),
    implementerTool: opts.implementerTool,
    ...(opts.implementerModel !== undefined && { implementerModel: opts.implementerModel }),
    ...(opts.reviewerTool !== undefined && { reviewerTool: opts.reviewerTool }),
    ...(opts.reviewerModel !== undefined && { reviewerModel: opts.reviewerModel }),
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
    ...(opts.lineageAttempts !== undefined && {
      lineageAttempt: opts.lineageAttempts.used + 1,
      attemptAllowance: opts.lineageAttempts.allowance,
    }),
  });
}

export function publishImplementerGenerateDone(
  ctx: BusContext,
  opts: {
    taskId: TaskId;
    file: string;
    diff?: string | undefined;
    linesAdded?: number | undefined;
    linesRemoved?: number | undefined;
    duration: number;
    noChange?: boolean | undefined;
  },
): void {
  const event: EngineEvent = {
    type: 'implementer_generate_done',
    ts: Date.now(),
    phase: ctx.phase,
    taskId: opts.taskId,
    file: opts.file,
    ...(opts.linesAdded !== undefined && { linesAdded: opts.linesAdded }),
    ...(opts.linesRemoved !== undefined && { linesRemoved: opts.linesRemoved }),
    duration: opts.duration,
    ...(opts.noChange === true && { noChange: true }),
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
