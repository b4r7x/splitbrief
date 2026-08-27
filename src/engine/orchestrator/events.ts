import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskId } from '../../core/schemas/task.js';
import type {
  RecoveryAction,
  TaskCompletionMethod,
  WorkflowMode,
  UserEditConflictAction,
  CurrentCodeContextMode,
  TaskContextFit,
  Phase,
} from '../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import type {
  EngineEvent,
  EngineEventOf,
  EventBus,
  ValidationStageAttempts,
  ValidationStageCommands,
  ValidationStages,
  ValidationStageSkips,
} from '../events/types.js';
import type { ValidationResult } from './validation/result.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import type { ImplementerPublisher } from '../implementers/types.js';
import type { EmittedChain } from '../../core/schemas/drift-chain.js';
import type { UserEditConflict, TaskReviewRequest } from '../events/workflow-events.js';
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
  readonly transcriptSafe: true;
}

interface PublishOperationalMessageOptions extends BusContext {
  message: string;
  taskId?: TaskId | undefined;
  safety?: OperationalMessageSafety | undefined;
}

type PlannerTextOptions = Pick<Partial<EngineEventOf<'planner_text'>>, 'role' | 'content'>;

let runnerCallEventSequence = 0;

export function publishRunnerCallEvent(
  ctx: BusContext & { taskId?: TaskId | undefined },
  event: RunnerCallEvent,
): void {
  const projected = projectRunnerCallEvents(event, {
    phase: ctx.phase,
    ...(ctx.taskId !== undefined && { taskId: ctx.taskId }),
    sequence: runnerCallEventSequence,
  });
  runnerCallEventSequence += 1;
  for (const projectedEvent of projected) ctx.bus.publish(projectedEvent);
}

const EMPTY_STAGES: ValidationStages = { typecheck: false, lint: false, test: false };

type ValidationPhase =
  | { phase: 'start'; commands?: ValidationStageCommands | undefined }
  | {
      phase: 'progress';
      stages: ValidationStages;
      startTime: number;
      activeStage?: ValidationResult['stage'] | undefined;
      commands?: ValidationStageCommands | undefined;
    }
  | { phase: 'result'; results: ValidationResult[]; startTime: number };

export function createBusTextHandler(
  ctx: BusContext,
  options: PlannerTextOptions = {},
): (text: string) => void {
  const { role, content } = options;
  return (text) =>
    ctx.bus.publish({
      type: 'planner_text',
      ts: Date.now(),
      phase: ctx.phase,
      text,
      ...(role !== undefined && { role }),
      ...(content !== undefined && { content }),
    });
}

export function publishPlannerStatus(
  bus: EventBus,
  state: WorkflowState,
  status: 'running' | 'done',
  extra?: { duration?: number; summary?: string; tool?: string; model?: string },
): void {
  const tool = extra?.tool ?? state.plannerTool;
  const model = extra?.model ?? state.plannerModel;
  bus.publish({
    type: 'planner_status',
    ts: Date.now(),
    phase: state.phase,
    status,
    ...(extra?.duration !== undefined && { duration: extra.duration }),
    ...(extra?.summary !== undefined && { summary: extra.summary }),
    ...(tool !== undefined && { tool }),
    ...(model !== undefined && { model }),
  });
}

// Announces the whole plan once, so consumers can show what is still coming instead of learning
// about each task only when it starts. `task_started` stays the per-task lifecycle signal.
export function publishTasksPlanned(
  ctx: BusContext,
  tasks: readonly { id: TaskId; title: string; file: string; action: 'create' | 'modify' }[],
): void {
  ctx.bus.publish({
    type: 'tasks_planned',
    ts: Date.now(),
    phase: ctx.phase,
    tasks: tasks.map((task, index) => ({
      id: task.id,
      title: task.title,
      index,
      file: task.file,
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
    file: string;
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
    costPosture?: string;
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

export function publishValidation(ctx: BusContext, taskId: TaskId, opts: ValidationPhase): void {
  if (opts.phase === 'start') {
    ctx.bus.publish({
      type: 'validate',
      ts: Date.now(),
      phase: ctx.phase,
      taskId,
      status: 'running',
      passed: false,
      stages: { ...EMPTY_STAGES },
      ...(hasValidationCommands(opts.commands) && { commands: opts.commands }),
    });
    return;
  }

  if (opts.phase === 'progress') {
    ctx.bus.publish({
      type: 'validate',
      ts: opts.startTime,
      phase: ctx.phase,
      taskId,
      status: 'running',
      passed: false,
      stages: opts.stages,
      ...(opts.activeStage !== undefined && { activeStage: opts.activeStage }),
      ...(hasValidationCommands(opts.commands) && { commands: opts.commands }),
    });
    return;
  }

  const stages: ValidationStages = { ...EMPTY_STAGES };
  const attempted: ValidationStageAttempts = { ...EMPTY_STAGES };
  const skipped: ValidationStageSkips = {};
  let failedError: string | undefined;
  let passed = true;
  const commands: ValidationStageCommands = {};
  for (const r of opts.results) {
    attempted[r.stage] = true;
    if (r.command !== undefined) commands[r.stage] = r.command;
    if (r.skipped) {
      skipped[r.stage] = true;
      continue;
    }
    if (r.stage === 'typecheck') stages.typecheck = r.passed;
    else if (r.stage === 'lint') stages.lint = r.passed;
    else if (r.stage === 'test') stages.test = r.passed;
    if (!r.passed) {
      passed = false;
      if (failedError === undefined) failedError = r.error;
    }
  }
  const hasSkips = Object.keys(skipped).length > 0;
  ctx.bus.publish({
    type: 'validate',
    ts: Date.now(),
    phase: ctx.phase,
    taskId,
    status: 'done',
    passed,
    stages,
    attempted,
    ...(hasValidationCommands(commands) && { commands }),
    ...(hasSkips && { skipped }),
    ...(failedError !== undefined && { error: failedError }),
    duration: Date.now() - opts.startTime,
  });
}

export function publishValidationBaseline(ctx: BusContext, opts: ValidationPhase): void {
  if (opts.phase === 'start') {
    ctx.bus.publish({
      type: 'validation_baseline',
      ts: Date.now(),
      phase: ctx.phase,
      status: 'running',
      stages: { ...EMPTY_STAGES },
      ...(hasValidationCommands(opts.commands) && { commands: opts.commands }),
    });
    return;
  }

  if (opts.phase === 'progress') {
    ctx.bus.publish({
      type: 'validation_baseline',
      ts: opts.startTime,
      phase: ctx.phase,
      status: 'running',
      stages: opts.stages,
      ...(opts.activeStage !== undefined && { activeStage: opts.activeStage }),
      ...(hasValidationCommands(opts.commands) && { commands: opts.commands }),
    });
    return;
  }

  const stages: ValidationStages = { ...EMPTY_STAGES };
  const failing: ValidationStageSkips = {};
  const commands: ValidationStageCommands = {};
  for (const r of opts.results) {
    if (r.command !== undefined) commands[r.stage] = r.command;
    if (r.skipped) continue;
    if (r.stage === 'typecheck') stages.typecheck = r.passed;
    else if (r.stage === 'lint') stages.lint = r.passed;
    else if (r.stage === 'test') stages.test = r.passed;
    if (!r.passed) failing[r.stage] = true;
  }
  const hasFailing = Object.keys(failing).length > 0;
  ctx.bus.publish({
    type: 'validation_baseline',
    ts: Date.now(),
    phase: ctx.phase,
    status: 'done',
    stages,
    ...(hasValidationCommands(commands) && { commands }),
    ...(hasFailing && { failing }),
    duration: Date.now() - opts.startTime,
  });
}

function hasValidationCommands(commands: ValidationStageCommands | undefined): boolean {
  if (commands === undefined) return false;
  return Object.values(commands).some((command) => command !== undefined && command.length > 0);
}

export function publishGitCommit(
  ctx: BusContext,
  taskId: TaskId,
  message: string,
  file?: string,
): void {
  ctx.bus.publish({
    type: 'git_commit',
    ts: Date.now(),
    phase: ctx.phase,
    taskId,
    message,
    ...(file !== undefined && { file }),
  });
}

export function publishGitBranchCreated(ctx: BusContext, name: string): void {
  ctx.bus.publish({ type: 'git_branch_created', ts: Date.now(), phase: ctx.phase, name });
}

export function publishGitCheckpoint(ctx: BusContext, taskId: TaskId, tag: string): void {
  ctx.bus.publish({ type: 'git_checkpoint', ts: Date.now(), phase: ctx.phase, taskId, tag });
}

export function publishRetry(
  opts: BusContext & { taskId: TaskId; attempt: number; maxRetries: number; error: string },
): void {
  opts.bus.publish({
    type: 'task_retry',
    ts: Date.now(),
    phase: opts.phase,
    taskId: opts.taskId,
    attempt: opts.attempt,
    maxRetries: opts.maxRetries,
    error: opts.error,
  });
}

export function publishEscalate(
  opts: BusContext & {
    taskId: TaskId;
    tier: 0 | 1 | 2;
    hint?: string | undefined;
    tool?: string | undefined;
    model?: string | undefined;
  },
): void {
  opts.bus.publish({
    type: 'escalate',
    ts: Date.now(),
    phase: opts.phase,
    taskId: opts.taskId,
    tier: opts.tier,
    ...(opts.hint !== undefined && { hint: opts.hint }),
    ...(opts.tool !== undefined && { tool: opts.tool }),
    ...(opts.model !== undefined && { model: opts.model }),
  });
}

export function publishCostUpdate(ctx: BusContext, tokenUsage: TokenUsage): void {
  ctx.bus.publish({ type: 'cost_update', ts: Date.now(), phase: ctx.phase, tokenUsage });
}

export function publishCostPrediction(ctx: BusContext, prediction: CostPrediction): void {
  ctx.bus.publish({ type: 'cost_prediction', ts: Date.now(), phase: ctx.phase, prediction });
}

export function publishBudgetWarning(
  opts: BusContext & { currentCost: number; maxBudget: number },
): void {
  opts.bus.publish({
    type: 'budget_warning',
    ts: Date.now(),
    phase: opts.phase,
    currentCost: opts.currentCost,
    maxBudget: opts.maxBudget,
  });
}

export function publishBudgetPaused(
  opts: BusContext & { currentCost: number; maxBudget: number; threshold: number },
): void {
  opts.bus.publish({
    type: 'budget_paused',
    ts: Date.now(),
    phase: opts.phase,
    currentCost: opts.currentCost,
    maxBudget: opts.maxBudget,
    threshold: opts.threshold,
  });
}

export function publishBudgetExceeded(
  opts: BusContext & { currentCost: number; maxBudget: number },
): void {
  opts.bus.publish({
    type: 'budget_exceeded',
    ts: Date.now(),
    phase: opts.phase,
    currentCost: opts.currentCost,
    maxBudget: opts.maxBudget,
  });
}

export function publishError(options: PublishOperationalMessageOptions): void {
  const { bus, phase, message, safety } = options;
  bus.publish({
    type: 'error',
    ts: Date.now(),
    phase,
    message,
    ...(safety !== undefined && {
      category: safety.category,
      code: safety.code,
      transcriptSafe: safety.transcriptSafe,
    }),
  });
}

export function publishWarning(options: PublishOperationalMessageOptions): void {
  const { bus, phase, message, taskId, safety } = options;
  bus.publish({
    type: 'warning',
    ts: Date.now(),
    phase,
    message,
    ...(taskId !== undefined && { taskId }),
    ...(safety !== undefined && {
      category: safety.category,
      code: safety.code,
      transcriptSafe: safety.transcriptSafe,
    }),
  });
}

export function publishWarningFromError(ctx: BusContext, label: string, err: unknown): void {
  publishWarning({ ...ctx, message: labelError(label, err) });
}

export function publishUserMessage(ctx: BusContext, text: string): void {
  ctx.bus.publish({ type: 'user_message', ts: Date.now(), phase: ctx.phase, text });
}

export function publishUserEditConflict(
  ctx: BusContext,
  conflict: UserEditConflict,
  selectedAction?: UserEditConflictAction,
): void {
  ctx.bus.publish({
    type: 'paused_external_changes',
    ts: Date.now(),
    phase: ctx.phase,
    conflict,
    ...(selectedAction !== undefined && { selectedAction }),
  });
}

export function publishRecoveryPrompted(bus: EventBus, issue: RecoveryIssue): void {
  bus.publish({
    type: 'recovery_prompted',
    ts: Date.now(),
    phase: issue.phase,
    issueId: issue.id,
    reason: issue.reason,
    ...(issue.taskId !== undefined && { taskId: issue.taskId }),
    files: issue.files,
    affectedTaskIds: issue.affectedTaskIds,
    availableActions: issue.availableActions,
    recommendedAction: issue.recommendedAction,
  });
}

export function publishTaskReviewNeeded(ctx: BusContext, request: TaskReviewRequest): void {
  ctx.bus.publish({ type: 'task_review_needed', ts: Date.now(), phase: ctx.phase, ...request });
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

type RecoveryEventOpts = {
  bus: EventBus;
  issue: RecoveryIssue;
  action: RecoveryAction;
};

function publishRecoveryEvent(
  { bus, issue, action }: RecoveryEventOpts,
  spec: RecoveryEventSpec,
): void {
  const base = {
    ts: Date.now(),
    phase: issue.phase,
    issueId: issue.id,
    reason: issue.reason,
    action,
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
    mode: WorkflowMode;
    plannerTool: string;
    plannerModel?: string | undefined;
    implementerTool: string;
    implementerModel?: string | undefined;
    reviewerTool?: string | undefined;
    reviewerModel?: string | undefined;
  },
): void {
  ctx.bus.publish({
    type: 'workflow_config',
    ts: Date.now(),
    phase: ctx.phase,
    mode: opts.mode,
    plannerTool: opts.plannerTool,
    ...(opts.plannerModel !== undefined && { plannerModel: opts.plannerModel }),
    implementerTool: opts.implementerTool,
    ...(opts.implementerModel !== undefined && { implementerModel: opts.implementerModel }),
    ...(opts.reviewerTool !== undefined && { reviewerTool: opts.reviewerTool }),
    ...(opts.reviewerModel !== undefined && { reviewerModel: opts.reviewerModel }),
  });
}

export function publishImplementerGenerateRunning(
  ctx: BusContext,
  taskId: TaskId,
  file?: string,
): void {
  ctx.bus.publish({
    type: 'implementer_generate_running',
    ts: Date.now(),
    phase: ctx.phase,
    taskId,
    ...(file !== undefined && { file }),
  });
}

export function publishImplementerGenerateDone(
  ctx: BusContext,
  opts: {
    taskId: TaskId;
    file: string;
    diff?: string | undefined;
    linesAdded: number;
    linesRemoved: number;
    duration: number;
  },
): void {
  const event: EngineEvent = {
    type: 'implementer_generate_done',
    ts: Date.now(),
    phase: ctx.phase,
    taskId: opts.taskId,
    file: opts.file,
    linesAdded: opts.linesAdded,
    linesRemoved: opts.linesRemoved,
    duration: opts.duration,
  };
  if (opts.diff !== undefined) event.diff = redactSecrets(opts.diff);
  ctx.bus.publish(event);
}

function publishImplementerGenerateFailed(ctx: BusContext, taskId: TaskId, model?: string): void {
  ctx.bus.publish({
    type: 'implementer_generate_failed',
    ts: Date.now(),
    phase: ctx.phase,
    taskId,
    ...(model !== undefined && { model }),
  });
}

export function createImplementerPublisher(bus: EventBus): ImplementerPublisher {
  return {
    publishRunning: ({ phase, taskId, file }) =>
      publishImplementerGenerateRunning({ bus, phase }, taskId, file),
    publishCallEvent: ({ phase, taskId, event }) =>
      publishRunnerCallEvent({ bus, phase, taskId }, event),
    publishDone: ({ phase, ...opts }) => publishImplementerGenerateDone({ bus, phase }, opts),
    publishFailed: ({ phase, taskId, model }) =>
      publishImplementerGenerateFailed({ bus, phase }, taskId, model),
    publishWarning: ({ phase, taskId, message, safety }) =>
      publishWarning({ bus, phase, taskId, message, safety }),
  };
}

export function publishDriftChainDetected(
  ctx: BusContext,
  chain: EmittedChain,
  threshold: number,
): void {
  ctx.bus.publish({
    type: 'drift_chain_detected',
    ts: Date.now(),
    phase: ctx.phase,
    chainLength: chain.chainLength,
    score: chain.score,
    threshold,
    uniqueOutOfBoundsFiles: chain.uniqueOutOfBoundsFiles,
    representativePath: chain.representativePath,
  });
}
