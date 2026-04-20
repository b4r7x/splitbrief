import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { Phase, TaskCompletionMethod, WorkflowMode } from '../../core/schemas/enums.js';
import type { ValidationStages } from '../events/types.js';
import type { ValidationResult } from '../../core/types/summary.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import type { EventBus, EngineEvent } from '../events/types.js';

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
  opts: { taskId: TaskId; title: string; index: number; total: number; file: string; action: 'create' | 'modify'; tool?: string; model?: string },
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
  opts: { taskId: TaskId; title: string; method: TaskCompletionMethod; retries: number; duration: number; tool?: string; model?: string },
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

export function publishImplementerGenerateDone(bus: EventBus, phase: Phase, opts: { taskId: TaskId; file: string; diff?: string; linesAdded: number; linesRemoved: number; duration: number }): void {
  bus.publish({ type: 'implementer_generate_done', ts: Date.now(), phase, ...opts });
}

export function publishImplementerGenerateFailed(bus: EventBus, phase: Phase, taskId: TaskId, model: string): void {
  bus.publish({ type: 'implementer_generate_failed', ts: Date.now(), phase, taskId, model });
}

/** Low-level publish for sites that don't fit a typed helper. Prefer the publish* helpers above when one applies. */
export function publishEvent(bus: EventBus, event: EngineEvent): void {
  bus.publish(event);
}
