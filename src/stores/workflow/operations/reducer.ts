import type { EngineEvent } from '../../../engine/events/types.js';
import {
  cancelRunningOperations,
  operationStatusFromFailure,
  startRunnerOperation,
  terminalizeKnownOperation,
  updateKnownOperation,
} from './runner.js';
import { closePlannerStatusFallbacks, updatePlannerStatusFallback } from './planner-status.js';
import type { OperationsState } from './state.js';
import { appendWarning, showsWarningOnPrimarySurface } from './warnings.js';

export function updateOperations(state: OperationsState, event: EngineEvent): OperationsState {
  switch (event.type) {
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
