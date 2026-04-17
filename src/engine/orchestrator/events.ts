import type { WorkflowState, TaskId } from '../../core/types/state-actions.js';
import type { WorkflowMode } from '../../core/types/config-options.js';
import type { OrchestratorCallbacks, ValidationStages, OrchestratorEventPayloadMap } from '../../core/types/events.js';
import type { ValidationResult, TaskCompletionMethod, TokenUsage, CostPrediction } from '../../core/types/summary.js';
import { appendEvent } from '../../core/state/persistence.js';
import { transitionAndEmit } from './helpers.js';

export type PlanApprovedContext = {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
};

export function emit<T extends keyof OrchestratorEventPayloadMap>(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  type: T,
  taskId: TaskId | undefined,
  data: OrchestratorEventPayloadMap[T],
): void {
  appendEvent(projectDir, sessionId, {
    ts: Date.now(),
    type,
    taskId,
    phase: state.phase,
    data,
  });
}

const EMPTY_STAGES: ValidationStages = { tsc: false, lint: false, test: false };

type ValidationPhase =
  | { phase: 'start' }
  | { phase: 'progress'; stages: ValidationStages; startTime: number }
  | { phase: 'result'; results: ValidationResult[]; startTime: number };

export function emitValidation(callbacks: OrchestratorCallbacks, opts: ValidationPhase): void {
  if (opts.phase === 'start') {
    callbacks.onEvent({
      type: 'validate', ts: Date.now(), status: 'running', passed: false,
      stages: { ...EMPTY_STAGES },
    });
    return;
  }

  if (opts.phase === 'progress') {
    callbacks.onEvent({
      type: 'validate', ts: opts.startTime, status: 'running', passed: false, stages: opts.stages,
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
  callbacks.onEvent({
    type: 'validate', ts: Date.now(), status: 'done', passed,
    stages,
    error: failedError,
    duration: Date.now() - opts.startTime,
  });
}

export function emitPlanApproved(state: WorkflowState, ctx: PlanApprovedContext): WorkflowState {
  return transitionAndEmit({
    state,
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    callbacks: ctx.callbacks,
    action: { type: 'APPROVE_PLAN' },
    eventName: 'plan_approved',
    status: 'running',
    emitData: {},
  });
}

export function createTextHandler(callbacks: OrchestratorCallbacks): (text: string) => void {
  return (text) => callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text });
}

export function emitError(callbacks: OrchestratorCallbacks, message: string): void {
  callbacks.onEvent({ type: 'error', ts: Date.now(), message });
}

export function emitWarning(callbacks: OrchestratorCallbacks, message: string): void {
  callbacks.onEvent({ type: 'warning', ts: Date.now(), message });
}

export function emitPlannerStatus(
  callbacks: OrchestratorCallbacks, state: WorkflowState,
  status: 'running' | 'done', extra?: { duration?: number; summary?: string; tool?: string; model?: string },
): void {
  const tool = extra?.tool ?? state.plannerTool;
  const model = extra?.model ?? state.plannerModel;
  callbacks.onEvent({
    type: 'planner-status', ts: Date.now(), phase: state.phase, status,
    ...extra,
    ...(tool !== undefined && { tool }),
    ...(model !== undefined && { model }),
  });
}

export function emitTaskStart(
  callbacks: OrchestratorCallbacks,
  opts: { taskId: TaskId; title: string; index: number; total: number; file: string; action: 'create' | 'modify'; tool?: string; model?: string },
): void {
  callbacks.onEvent({ type: 'task-start', ts: Date.now(), ...opts });
}

export function emitTaskSkipped(
  callbacks: OrchestratorCallbacks,
  opts: { taskId: TaskId; title: string; reason: string },
): void {
  callbacks.onEvent({ type: 'task-skipped', ts: Date.now(), ...opts });
}

export function emitTaskComplete(
  callbacks: OrchestratorCallbacks,
  opts: { taskId: TaskId; title: string; method: TaskCompletionMethod; retries: number; duration: number; tool?: string; model?: string },
): void {
  callbacks.onEvent({ type: 'task-complete', ts: Date.now(), ...opts });
}

export function emitGitCommit(callbacks: OrchestratorCallbacks, message: string): void {
  callbacks.onEvent({ type: 'git-commit', ts: Date.now(), message });
}

export function emitGitCheckpoint(callbacks: OrchestratorCallbacks, tag: string, taskId: TaskId): void {
  callbacks.onEvent({ type: 'git-checkpoint', ts: Date.now(), tag, taskId });
}

export function emitRetry(callbacks: OrchestratorCallbacks, taskId: TaskId, attempt: number, maxRetries: number): void {
  callbacks.onEvent({ type: 'retry', ts: Date.now(), taskId, attempt, maxRetries });
}

export function emitEscalate(callbacks: OrchestratorCallbacks, tier: 0 | 1 | 2, hint?: string, tool?: string, model?: string): void {
  callbacks.onEvent({
    type: 'escalate', ts: Date.now(), tier,
    ...(hint !== undefined && { hint }),
    ...(tool !== undefined && { tool }),
    ...(model !== undefined && { model }),
  });
}

export function emitCostUpdate(callbacks: OrchestratorCallbacks, tokenUsage: TokenUsage): void {
  callbacks.onEvent({ type: 'cost-update', ts: Date.now(), tokenUsage });
}

export function emitCostPrediction(callbacks: OrchestratorCallbacks, prediction: CostPrediction): void {
  callbacks.onEvent({ type: 'cost-prediction', ts: Date.now(), prediction });
}

export function emitBudgetWarning(callbacks: OrchestratorCallbacks, currentCost: number, maxBudget: number): void {
  callbacks.onEvent({ type: 'budget-warning', ts: Date.now(), currentCost, maxBudget });
}

export function emitBudgetExceeded(callbacks: OrchestratorCallbacks, currentCost: number, maxBudget: number): void {
  callbacks.onEvent({ type: 'budget-exceeded', ts: Date.now(), currentCost, maxBudget });
}

export function emitUserMessage(callbacks: OrchestratorCallbacks, text: string): void {
  callbacks.onEvent({ type: 'user-message', ts: Date.now(), text });
}

export function emitWorkflowConfig(callbacks: OrchestratorCallbacks, opts: {
  mode: WorkflowMode;
  plannerTool: string;
  plannerModel?: string | undefined;
  implementerTool: string;
  implementerModel?: string | undefined;
}): void {
  callbacks.onEvent({
    type: 'workflow-config', ts: Date.now(),
    mode: opts.mode,
    plannerTool: opts.plannerTool,
    ...(opts.plannerModel !== undefined && { plannerModel: opts.plannerModel }),
    implementerTool: opts.implementerTool,
    ...(opts.implementerModel !== undefined && { implementerModel: opts.implementerModel }),
  });
}

export function createEventEmitter(projectDir: string, sessionId: string) {
  return <T extends keyof OrchestratorEventPayloadMap>(
    state: WorkflowState,
    type: T,
    taskId: TaskId | undefined,
    data: OrchestratorEventPayloadMap[T],
  ): void => emit(projectDir, sessionId, state, type, taskId, data);
}
