import type { WorkflowState, OrchestratorCallbacks, ValidationResult, OrchestratorEventType } from '../../types.js';
import { appendEvent } from '../../core/state/persistence.js';
import { allValidationsPassed } from './helpers.js';

export function emit(projectDir: string, state: WorkflowState, type: OrchestratorEventType, taskId?: string, data?: Record<string, unknown>): void {
  appendEvent(projectDir, {
    ts: Date.now(),
    type,
    taskId,
    phase: state.phase,
    data,
  });
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
  const passed = allValidationsPassed(validationResults);
  const failedStage = validationResults.find(r => !r.passed);
  callbacks.onEvent({
    type: 'validate', ts: Date.now(), status: 'done', passed,
    stages: {
      tsc: validationResults.find(r => r.stage === 'typecheck')?.passed ?? true,
      lint: validationResults.find(r => r.stage === 'lint')?.passed ?? true,
      test: validationResults.find(r => r.stage === 'test')?.passed ?? true,
    },
    error: failedStage?.error,
    duration: Date.now() - startTime,
  });
}

export function createTextHandler(callbacks: OrchestratorCallbacks): (text: string) => void {
  return (text) => callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text });
}
