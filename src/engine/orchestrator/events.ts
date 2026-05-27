import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { RecoveryAction, TaskCompletionMethod, WorkflowMode } from '../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../core/schemas/recovery.js';
import type { EngineEvent, EventBus, ValidationStages } from '../events/types.js';
import type { ValidationResult } from './validation-types.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import type { ImplementerPublisher } from '../implementers/types.js';
import type { EmittedChain } from '../../core/schemas/drift-chain.js';
import type { BusContext } from '../types/bus-context.js';
import type { UserEditConflict, UserEditConflictAction, CurrentCodeContextMode, TaskContextFit, TaskReviewRequest } from '../events/workflow-events.js';
import { labelError } from '../../utils/format-errors.js';

const EMPTY_STAGES: ValidationStages = { typecheck: false, lint: false, test: false };

type ValidationPhase =
  | { phase: 'start' }
  | { phase: 'progress'; stages: ValidationStages; startTime: number }
  | { phase: 'result'; results: ValidationResult[]; startTime: number };

export function createBusTextHandler(ctx: BusContext): (text: string) => void {
  return (text) => ctx.bus.publish({ type: 'planner_text', ts: Date.now(), phase: ctx.phase, text });
}

export function publishPlannerStatus(
  bus: EventBus, state: WorkflowState,
  status: 'running' | 'done', extra?: { duration?: number; summary?: string; tool?: string; model?: string },
): void {
  const tool = extra?.tool ?? state.plannerTool;
  const model = extra?.model ?? state.plannerModel;
  bus.publish({
    type: 'planner_status', ts: Date.now(), phase: state.phase, status,
    ...(extra?.duration !== undefined && { duration: extra.duration }),
    ...(extra?.summary !== undefined && { summary: extra.summary }),
    ...(tool !== undefined && { tool }),
    ...(model !== undefined && { model }),
  });
}

export function publishTaskStart(
  ctx: BusContext,
  opts: { taskId: TaskId; title: string; index: number; total: number; file: string; action: 'create' | 'modify'; tool?: string; model?: string; implementerProfile?: string; contextFit?: TaskContextFit; estimatedTokens?: number; untruncatedEstimatedTokens?: number; contextLength?: number; currentCodeTruncated?: boolean; currentCodeContextMode?: CurrentCodeContextMode; costPosture?: string; routingReason?: string },
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
  opts: { taskId: TaskId; title: string; method: TaskCompletionMethod; retries: number; duration: number; tool?: string; model?: string; implementerProfile?: string },
): void {
  ctx.bus.publish({ type: 'task_completed', ts: Date.now(), phase: ctx.phase, ...opts });
}

export function publishValidation(ctx: BusContext, taskId: TaskId, opts: ValidationPhase): void {
  if (opts.phase === 'start') {
    ctx.bus.publish({
      type: 'validate', ts: Date.now(), phase: ctx.phase, taskId,
      status: 'running', passed: false, stages: { ...EMPTY_STAGES },
    });
    return;
  }

  if (opts.phase === 'progress') {
    ctx.bus.publish({
      type: 'validate', ts: opts.startTime, phase: ctx.phase, taskId,
      status: 'running', passed: false, stages: opts.stages,
    });
    return;
  }

  const stages: ValidationStages = { ...EMPTY_STAGES };
  let failedError: string | undefined;
  let passed = true;
  for (const r of opts.results) {
    if (r.stage === 'typecheck') stages.typecheck = r.passed;
    else if (r.stage === 'lint') stages.lint = r.passed;
    else if (r.stage === 'test') stages.test = r.passed;
    if (!r.passed) {
      passed = false;
      if (failedError === undefined) failedError = r.error;
    }
  }
  ctx.bus.publish({
    type: 'validate', ts: Date.now(), phase: ctx.phase, taskId,
    status: 'done', passed, stages,
    ...(failedError !== undefined && { error: failedError }),
    duration: Date.now() - opts.startTime,
  });
}

export function publishGitCommit(ctx: BusContext, taskId: TaskId, message: string, file?: string): void {
  ctx.bus.publish({ type: 'git_commit', ts: Date.now(), phase: ctx.phase, taskId, message, ...(file !== undefined && { file }) });
}

export function publishGitBranchCreated(ctx: BusContext, name: string): void {
  ctx.bus.publish({ type: 'git_branch_created', ts: Date.now(), phase: ctx.phase, name });
}

export function publishGitCheckpoint(ctx: BusContext, taskId: TaskId, tag: string): void {
  ctx.bus.publish({ type: 'git_checkpoint', ts: Date.now(), phase: ctx.phase, taskId, tag });
}

export function publishRetry(ctx: BusContext, taskId: TaskId, attempt: number, maxRetries: number, error: string): void {
  ctx.bus.publish({ type: 'task_retry', ts: Date.now(), phase: ctx.phase, taskId, attempt, maxRetries, error });
}

export function publishEscalate(opts: BusContext & { taskId: TaskId; tier: 0 | 1 | 2; hint?: string | undefined; tool?: string | undefined; model?: string | undefined }): void {
  opts.bus.publish({
    type: 'escalate', ts: Date.now(), phase: opts.phase, taskId: opts.taskId, tier: opts.tier,
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

export function publishBudgetWarning(ctx: BusContext, currentCost: number, maxBudget: number): void {
  ctx.bus.publish({ type: 'budget_warning', ts: Date.now(), phase: ctx.phase, currentCost, maxBudget });
}

export function publishBudgetPaused(ctx: BusContext, currentCost: number, maxBudget: number, threshold: number): void {
  ctx.bus.publish({ type: 'budget_paused', ts: Date.now(), phase: ctx.phase, currentCost, maxBudget, threshold });
}

export function publishBudgetExceeded(ctx: BusContext, currentCost: number, maxBudget: number): void {
  ctx.bus.publish({ type: 'budget_exceeded', ts: Date.now(), phase: ctx.phase, currentCost, maxBudget });
}

export function publishError(ctx: BusContext, message: string): void {
  ctx.bus.publish({ type: 'error', ts: Date.now(), phase: ctx.phase, message });
}

export function publishWarning(ctx: BusContext, message: string): void {
  ctx.bus.publish({ type: 'warning', ts: Date.now(), phase: ctx.phase, message });
}

export function publishWarningFromError(ctx: BusContext, label: string, err: unknown): void {
  publishWarning(ctx, labelError(label, err));
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

type RecoveryEventSpec =
  | { kind: 'selected' }
  | { kind: 'failed'; message: string }
  | {
      kind: 'resolved';
      outcome: 'continued' | 'retry-current-task' | 'skipped-current-task' | 'aborted';
      implementerProfile?: string | undefined;
    };

export function publishRecoveryEvent(
  bus: EventBus,
  issue: RecoveryIssue,
  action: RecoveryAction,
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

export function publishRecoveryActionSelected(
  bus: EventBus,
  issue: RecoveryIssue,
  action: RecoveryAction,
): void {
  publishRecoveryEvent(bus, issue, action, { kind: 'selected' });
}

export function publishRecoveryActionFailed(
  bus: EventBus,
  issue: RecoveryIssue,
  action: RecoveryAction,
  message: string,
): void {
  publishRecoveryEvent(bus, issue, action, { kind: 'failed', message });
}

export function publishRecoveryResolved(
  bus: EventBus,
  issue: RecoveryIssue,
  action: RecoveryAction,
  outcome: 'continued' | 'retry-current-task' | 'skipped-current-task' | 'aborted',
  implementerProfile?: string | undefined,
): void {
  publishRecoveryEvent(bus, issue, action, {
    kind: 'resolved',
    outcome,
    ...(implementerProfile !== undefined && { implementerProfile }),
  });
}

export function publishWorkflowConfig(ctx: BusContext, opts: {
  mode: WorkflowMode;
  plannerTool: string;
  plannerModel?: string | undefined;
  implementerTool: string;
  implementerModel?: string | undefined;
}): void {
  ctx.bus.publish({
    type: 'workflow_config', ts: Date.now(), phase: ctx.phase,
    mode: opts.mode,
    plannerTool: opts.plannerTool,
    ...(opts.plannerModel !== undefined && { plannerModel: opts.plannerModel }),
    implementerTool: opts.implementerTool,
    ...(opts.implementerModel !== undefined && { implementerModel: opts.implementerModel }),
  });
}

export function publishImplementerGenerateRunning(ctx: BusContext, taskId: TaskId, file?: string): void {
  ctx.bus.publish({ type: 'implementer_generate_running', ts: Date.now(), phase: ctx.phase, taskId, ...(file !== undefined && { file }) });
}

export function publishImplementerGenerateDone(ctx: BusContext, opts: { taskId: TaskId; file: string; diff?: string | undefined; linesAdded: number; linesRemoved: number; duration: number }): void {
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
  if (opts.diff !== undefined) event.diff = opts.diff;
  ctx.bus.publish(event);
}

function publishImplementerGenerateFailed(ctx: BusContext, taskId: TaskId, model: string): void {
  ctx.bus.publish({ type: 'implementer_generate_failed', ts: Date.now(), phase: ctx.phase, taskId, model });
}

export function createImplementerPublisher(bus: EventBus): ImplementerPublisher {
  return {
    publishRunning: ({ phase, taskId, file }) => publishImplementerGenerateRunning({ bus, phase }, taskId, file),
    publishDone: ({ phase, ...opts }) => publishImplementerGenerateDone({ bus, phase }, opts),
    publishFailed: ({ phase, taskId, model }) => publishImplementerGenerateFailed({ bus, phase }, taskId, model),
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
