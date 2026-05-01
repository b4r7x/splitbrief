import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { Phase, RecoveryAction, TaskCompletionMethod, WorkflowMode } from '../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../core/schemas/recovery.js';
import type { ValidationStages } from '../events/types.js';
import type { ValidationResult } from './validation.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import type { EventBus, EngineEvent } from '../events/types.js';
import type { ImplementerPublisher } from '../implementers/types.js';
import type { EmittedChain } from '../../core/schemas/drift-chain.js';
import type { UserEditConflict, UserEditConflictAction } from './user-edit/conflicts.js';
import type { CurrentCodeContextMode, TaskContextFit } from './context-routing.js';
import type { TaskReviewRequest } from './task/review.js';

const EMPTY_STAGES: ValidationStages = { tsc: false, lint: false, test: false };

type ValidationPhase =
  | { phase: 'start' }
  | { phase: 'progress'; stages: ValidationStages; startTime: number }
  | { phase: 'result'; results: ValidationResult[]; startTime: number };

export function createBusTextHandler(bus: EventBus, phase: Phase): (text: string) => void {
  return (text) => bus.publish({ type: 'planner_text', ts: Date.now(), phase, text });
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
  bus: EventBus, phase: Phase,
  opts: { taskId: TaskId; title: string; index: number; total: number; file: string; action: 'create' | 'modify'; tool?: string; model?: string; implementerProfile?: string; contextFit?: TaskContextFit; estimatedTokens?: number; untruncatedEstimatedTokens?: number; contextLength?: number; currentCodeTruncated?: boolean; currentCodeContextMode?: CurrentCodeContextMode; costPosture?: string; routingReason?: string },
): void {
  bus.publish({ type: 'task_started', ts: Date.now(), phase, ...opts });
}

export function publishTaskSkipped(
  bus: EventBus, phase: Phase,
  opts: { taskId: TaskId; title: string; reason: string },
): void {
  bus.publish({ type: 'task_skipped', ts: Date.now(), phase, ...opts });
}

export function publishTaskComplete(
  bus: EventBus, phase: Phase,
  opts: { taskId: TaskId; title: string; method: TaskCompletionMethod; retries: number; duration: number; tool?: string; model?: string; implementerProfile?: string },
): void {
  bus.publish({ type: 'task_completed', ts: Date.now(), phase, ...opts });
}

export function publishValidation(bus: EventBus, workflowPhase: Phase, taskId: TaskId, opts: ValidationPhase): void {
  if (opts.phase === 'start') {
    bus.publish({
      type: 'validate', ts: Date.now(), phase: workflowPhase, taskId,
      status: 'running', passed: false, stages: { ...EMPTY_STAGES },
    });
    return;
  }

  if (opts.phase === 'progress') {
    bus.publish({
      type: 'validate', ts: opts.startTime, phase: workflowPhase, taskId,
      status: 'running', passed: false, stages: opts.stages,
    });
    return;
  }

  const stages: ValidationStages = { ...EMPTY_STAGES };
  let failedError: string | undefined;
  let passed = true;
  for (const r of opts.results) {
    if (r.stage === 'tsc') stages.tsc = r.passed;
    else if (r.stage === 'lint') stages.lint = r.passed;
    else if (r.stage === 'test') stages.test = r.passed;
    if (!r.passed) {
      passed = false;
      if (failedError === undefined) failedError = r.error;
    }
  }
  bus.publish({
    type: 'validate', ts: Date.now(), phase: workflowPhase, taskId,
    status: 'done', passed, stages,
    ...(failedError !== undefined && { error: failedError }),
    duration: Date.now() - opts.startTime,
  });
}

export function publishGitCommit(bus: EventBus, phase: Phase, taskId: TaskId, message: string, file?: string): void {
  bus.publish({ type: 'git_commit', ts: Date.now(), phase, taskId, message, ...(file !== undefined && { file }) });
}

export function publishGitBranchCreated(bus: EventBus, phase: Phase, name: string): void {
  bus.publish({ type: 'git_branch_created', ts: Date.now(), phase, name });
}

export function publishGitCheckpoint(bus: EventBus, phase: Phase, taskId: TaskId, tag: string): void {
  bus.publish({ type: 'git_checkpoint', ts: Date.now(), phase, taskId, tag });
}

export function publishRetry(bus: EventBus, phase: Phase, taskId: TaskId, attempt: number, maxRetries: number, error: string): void {
  bus.publish({ type: 'task_retry', ts: Date.now(), phase, taskId, attempt, maxRetries, error });
}

export function publishEscalate(bus: EventBus, phase: Phase, taskId: TaskId, tier: 0 | 1 | 2, hint?: string, tool?: string, model?: string): void {
  bus.publish({
    type: 'escalate', ts: Date.now(), phase, taskId, tier,
    ...(hint !== undefined && { hint }),
    ...(tool !== undefined && { tool }),
    ...(model !== undefined && { model }),
  });
}

export function publishCostUpdate(bus: EventBus, phase: Phase, tokenUsage: TokenUsage): void {
  bus.publish({ type: 'cost_update', ts: Date.now(), phase, tokenUsage });
}

export function publishCostPrediction(bus: EventBus, phase: Phase, prediction: CostPrediction): void {
  bus.publish({ type: 'cost_prediction', ts: Date.now(), phase, prediction });
}

export function publishBudgetWarning(bus: EventBus, phase: Phase, currentCost: number, maxBudget: number): void {
  bus.publish({ type: 'budget_warning', ts: Date.now(), phase, currentCost, maxBudget });
}

export function publishBudgetPaused(bus: EventBus, phase: Phase, currentCost: number, maxBudget: number, threshold: number): void {
  bus.publish({ type: 'budget_paused', ts: Date.now(), phase, currentCost, maxBudget, threshold });
}

export function publishBudgetExceeded(bus: EventBus, phase: Phase, currentCost: number, maxBudget: number): void {
  bus.publish({ type: 'budget_exceeded', ts: Date.now(), phase, currentCost, maxBudget });
}

export function publishError(bus: EventBus, phase: Phase, message: string): void {
  bus.publish({ type: 'error', ts: Date.now(), phase, message });
}

export function publishWarning(bus: EventBus, phase: Phase, message: string): void {
  bus.publish({ type: 'warning', ts: Date.now(), phase, message });
}

export function publishUserMessage(bus: EventBus, phase: Phase, text: string): void {
  bus.publish({ type: 'user_message', ts: Date.now(), phase, text });
}

export function publishUserEditConflict(
  bus: EventBus,
  phase: Phase,
  conflict: UserEditConflict,
  selectedAction?: UserEditConflictAction,
): void {
  bus.publish({
    type: 'paused_external_changes',
    ts: Date.now(),
    phase,
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

export function publishTaskReviewNeeded(bus: EventBus, phase: Phase, request: TaskReviewRequest): void {
  bus.publish({ type: 'task_review_needed', ts: Date.now(), phase, ...request });
}

export function publishRecoveryActionSelected(
  bus: EventBus,
  issue: RecoveryIssue,
  action: RecoveryAction,
): void {
  bus.publish({
    type: 'recovery_action_selected',
    ts: Date.now(),
    phase: issue.phase,
    issueId: issue.id,
    reason: issue.reason,
    action,
  });
}

export function publishRecoveryActionFailed(
  bus: EventBus,
  issue: RecoveryIssue,
  action: RecoveryAction,
  message: string,
): void {
  bus.publish({
    type: 'recovery_action_failed',
    ts: Date.now(),
    phase: issue.phase,
    issueId: issue.id,
    reason: issue.reason,
    action,
    message,
  });
}

export function publishRecoveryResolved(
  bus: EventBus,
  issue: RecoveryIssue,
  action: RecoveryAction,
  outcome: 'continued' | 'retry-current-task' | 'skipped-current-task' | 'aborted',
  implementerProfile?: string | undefined,
): void {
  bus.publish({
    type: 'recovery_resolved',
    ts: Date.now(),
    phase: issue.phase,
    issueId: issue.id,
    reason: issue.reason,
    action,
    outcome,
    ...(implementerProfile !== undefined && { implementerProfile }),
  });
}

export function publishWorkflowConfig(bus: EventBus, phase: Phase, opts: {
  mode: WorkflowMode;
  plannerTool: string;
  plannerModel?: string | undefined;
  implementerTool: string;
  implementerModel?: string | undefined;
}): void {
  bus.publish({
    type: 'workflow_config', ts: Date.now(), phase,
    mode: opts.mode,
    plannerTool: opts.plannerTool,
    ...(opts.plannerModel !== undefined && { plannerModel: opts.plannerModel }),
    implementerTool: opts.implementerTool,
    ...(opts.implementerModel !== undefined && { implementerModel: opts.implementerModel }),
  });
}

export function publishImplementerGenerateRunning(bus: EventBus, phase: Phase, taskId: TaskId, file?: string): void {
  bus.publish({ type: 'implementer_generate_running', ts: Date.now(), phase, taskId, ...(file !== undefined && { file }) });
}

export function publishImplementerGenerateDone(bus: EventBus, phase: Phase, opts: { taskId: TaskId; file: string; diff?: string | undefined; linesAdded: number; linesRemoved: number; duration: number }): void {
  const event: EngineEvent = {
    type: 'implementer_generate_done',
    ts: Date.now(),
    phase,
    taskId: opts.taskId,
    file: opts.file,
    linesAdded: opts.linesAdded,
    linesRemoved: opts.linesRemoved,
    duration: opts.duration,
  };
  if (opts.diff !== undefined) event.diff = opts.diff;
  bus.publish(event);
}

function publishImplementerGenerateFailed(bus: EventBus, phase: Phase, taskId: TaskId, model: string): void {
  bus.publish({ type: 'implementer_generate_failed', ts: Date.now(), phase, taskId, model });
}

export function createImplementerPublisher(bus: EventBus): ImplementerPublisher {
  return {
    publishRunning: ({ phase, taskId, file }) => publishImplementerGenerateRunning(bus, phase, taskId, file),
    publishDone: ({ phase, ...opts }) => publishImplementerGenerateDone(bus, phase, opts),
    publishFailed: ({ phase, taskId, model }) => publishImplementerGenerateFailed(bus, phase, taskId, model),
  };
}

export function publishDriftChainDetected(
  bus: EventBus,
  phase: Phase,
  chain: EmittedChain,
  threshold: number,
): void {
  bus.publish({
    type: 'drift_chain_detected',
    ts: Date.now(),
    phase,
    chainLength: chain.chainLength,
    score: chain.score,
    threshold,
    uniqueOutOfBoundsFiles: chain.uniqueOutOfBoundsFiles,
    representativePath: chain.representativePath,
  });
}

/** Low-level publish for sites that don't fit a typed helper. Prefer the publish* helpers above when one applies. */
export function publishEvent(bus: EventBus, event: EngineEvent): void {
  bus.publish(event);
}
