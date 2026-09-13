import type { EngineEvent } from '../../../engine/events/types.js';
import {
  cancelRunningOperations,
  operationStatusFromFailure,
  startRunnerOperation,
  terminalizeKnownOperation,
  updateKnownOperation,
} from './runner.js';
import { closePlannerStatusFallbacks, updatePlannerStatusFallback } from './planner-status.js';
import type { OperationsState, RunningValidationStage } from './state.js';
import { appendWarning, showsWarningOnPrimarySurface } from './warnings.js';

type ValidationEvent = Extract<EngineEvent, { type: 'validate' | 'validation_baseline' }>;

function runningValidationStage(event: ValidationEvent): RunningValidationStage | null {
  if (event.status !== 'running' || event.activeStage === undefined) return null;
  const stage = event.activeStage;
  return {
    stage,
    command: event.commands?.[stage] ?? null,
    stageStartedTs: event.ts,
  };
}

function applyValidationStage(state: OperationsState, event: ValidationEvent): OperationsState {
  const next = runningValidationStage(event);
  // A stage that is still the same stage keeps the clock it started on: the block reports how long
  // this command has been running, not how long since its last progress event.
  const current = state.validationStage ?? null;
  if (next !== null && current?.stage === next.stage) return state;
  if (next === null && current === null) return state;
  return { ...state, validationStage: next };
}

export function updateOperations(state: OperationsState, event: EngineEvent): OperationsState {
  switch (event.type) {
    case 'validate':
    case 'validation_baseline':
      return applyValidationStage(state, event);
    case 'runner_call_started':
      return startRunnerOperation(closePlannerStatusFallbacks(state, event.ts), event);
    case 'runner_call_usage':
      return updateKnownOperation(state, event.callId, (operation) => ({
        ...operation,
        usage: event.usage,
      }));
    case 'runner_call_warning':
      return updateKnownOperation(state, event.callId, (operation) =>
        operation.status === 'running' && showsWarningOnPrimarySurface(event.warning)
          ? { ...operation, warnings: appendWarning(operation.warnings, event.warning, event.ts) }
          : operation,
      );
    case 'runner_call_completed':
      return terminalizeKnownOperation(state, event.callId, {
        status: 'completed',
        endedAt: event.endedAt,
        durationMs: event.durationMs,
        reason: null,
        usage: event.usage,
        partial: false,
      });
    case 'runner_call_error':
      return terminalizeKnownOperation(state, event.callId, {
        status: operationStatusFromFailure(event.status),
        endedAt: event.endedAt,
        durationMs: event.durationMs,
        reason: event.error.message,
        usage: event.usage,
        partial: event.partial,
      });
    case 'workflow_cancelled':
      return cancelRunningOperations(state, {
        ts: event.ts,
        reason: event.reason ?? 'workflow_cancelled',
      });
    case 'planner_status':
      return updatePlannerStatusFallback(state, event);
    default:
      return state;
  }
}

export function markOperationsCancellationRequested(
  state: OperationsState,
  cancellation: { ts: number; reason: string },
): OperationsState {
  return cancelRunningOperations(state, cancellation);
}
