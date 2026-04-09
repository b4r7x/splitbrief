import type { WorkflowState, OrchestratorCallbacks, ValidationResult, TaskId, TaskCompletionMethod, TokenUsage, Phase } from '../../types.js';
import type { OrchestratorEvent, OrchestratorEventPayloadMap, OrchestratorEventType } from '../../core/types/events.js';
import { appendEvent } from '../../core/state/persistence.js';

type EventShape<T extends OrchestratorEventType> = {
  ts: number;
  type: T;
  taskId: TaskId | undefined;
  phase: Phase;
  data: OrchestratorEventPayloadMap[T];
};

export function emit<T extends keyof OrchestratorEventPayloadMap>(
  projectDir: string,
  state: WorkflowState,
  type: T,
  taskId: TaskId | undefined,
  data: OrchestratorEventPayloadMap[T],
): void {
  const event: EventShape<T> = {
    ts: Date.now(),
    type,
    taskId,
    phase: state.phase,
    data,
  };
  appendEvent(projectDir, event as OrchestratorEvent);
}

export function emitValidationStart(callbacks: OrchestratorCallbacks): void {
  callbacks.onEvent({
    type: 'validate', ts: Date.now(), status: 'running', passed: false,
    stages: { tsc: false, lint: false, test: false },
  });
}

export function emitValidationProgress(callbacks: OrchestratorCallbacks, stages: { tsc: boolean; lint: boolean; test: boolean }, startTime: number): void {
  callbacks.onEvent({
    type: 'validate', ts: startTime, status: 'running', passed: false, stages,
  });
}

export function emitValidationResult(callbacks: OrchestratorCallbacks, validationResults: ValidationResult[], startTime: number): void {
  const stages = { tsc: true, lint: true, test: true };
  let failedError: string | undefined;
  let passed = true;
  for (const r of validationResults) {
    if (r.stage === 'typecheck') stages.tsc = r.passed;
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
    duration: Date.now() - startTime,
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
  status: 'running' | 'done', extra?: { duration?: number; summary?: string },
): void {
  callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status, ...extra });
}

export function emitTaskStart(
  callbacks: OrchestratorCallbacks,
  opts: { taskId: TaskId; title: string; index: number; total: number; file: string; action: 'create' | 'modify' },
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
  opts: { taskId: TaskId; title: string; method: TaskCompletionMethod; retries: number; duration: number },
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

export function emitEscalate(callbacks: OrchestratorCallbacks, tier: 1 | 2): void {
  callbacks.onEvent({ type: 'escalate', ts: Date.now(), tier });
}

export function emitCostUpdate(callbacks: OrchestratorCallbacks, tokenUsage: TokenUsage): void {
  callbacks.onEvent({ type: 'cost-update', ts: Date.now(), tokenUsage });
}
