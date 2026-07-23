import type { EngineEventOf } from '../../../engine/events/types.js';
import { assertNever } from '../../../utils/type-guards.js';
import {
  cleanOperationReason,
  cleanOperationText,
  cleanOptionalOperationText,
  durationBetween,
} from './operation-text.js';
import { compactOperationsState } from './retention.js';
import type {
  ActiveOperation,
  OperationsState,
  RunningOperation,
  TerminalOperation,
  TerminalOperationStatus,
} from './state.js';

export interface TerminalUpdate {
  status: TerminalOperationStatus;
  endedAt: number;
  durationMs: number;
  reason: string | null;
  usage: unknown | null;
  partial: boolean;
}

interface OperationCancellation {
  ts: number;
  reason: string;
}

export function startRunnerOperation(
  state: OperationsState,
  event: EngineEventOf<'runner_call_started'>,
): OperationsState {
  const operation = operationFromRunnerStart(event);
  const byCallId = new Map(state.byCallId);
  byCallId.set(operation.callId, operation);
  return compactOperationsState({ ...state, active: operation, byCallId });
}

export function terminalizeKnownOperation(
  state: OperationsState,
  callId: string,
  update: TerminalUpdate,
): OperationsState {
  const operation = state.byCallId.get(callId);
  if (!operation) return state;
  return replaceOperation(state, terminalizeOperation(operation, update));
}

export function updateKnownOperation(
  state: OperationsState,
  callId: string,
  update: (operation: ActiveOperation) => ActiveOperation,
): OperationsState {
  const operation = state.byCallId.get(callId);
  if (!operation) return state;
  return replaceOperation(state, update(operation));
}

export function cancelRunningOperations(
  state: OperationsState,
  cancellation: OperationCancellation,
): OperationsState {
  let changed = false;
  let last = state.last;
  const byCallId = new Map(state.byCallId);

  for (const operation of state.byCallId.values()) {
    if (operation.status !== 'running') continue;
    const terminal = terminalizeRunningOperation(operation, {
      status: 'cancelled',
      endedAt: cancellation.ts,
      durationMs: durationBetween(operation.startedAt, cancellation.ts),
      reason: cancellation.reason,
      usage: operation.usage,
      partial: operation.partial,
    });
    byCallId.set(terminal.callId, terminal);
    last = terminal;
    changed = true;
  }

  if (!changed) return state;
  return compactOperationsState({ ...state, active: null, last, byCallId });
}

export function replaceOperation(
  state: OperationsState,
  operation: ActiveOperation,
): OperationsState {
  const byCallId = new Map(state.byCallId);
  byCallId.set(operation.callId, operation);
  const active =
    operation.status === 'running'
      ? operation
      : currentActiveAfterTerminal(state.active, operation.callId, byCallId);
  const last = operation.status === 'running' ? state.last : operation;
  return compactOperationsState({ ...state, active, last, byCallId });
}

export function terminalizeRunningOperation(
  operation: RunningOperation,
  update: TerminalUpdate,
): TerminalOperation {
  return {
    ...operation,
    status: update.status,
    endedAt: update.endedAt,
    durationMs: update.durationMs,
    reason: cleanOperationReason(update.reason),
    usage: update.usage ?? operation.usage,
    partial: update.partial,
  };
}

export function operationStatusFromFailure(
  status: EngineEventOf<'runner_call_error'>['status'],
): TerminalOperationStatus {
  switch (status) {
    case 'failed':
    case 'truncated':
    case 'aborted':
    case 'timeout':
    case 'refused':
    case 'unsupported_tool':
    case 'incomplete':
      return status;
    default:
      return assertNever(status);
  }
}

function operationFromRunnerStart(event: EngineEventOf<'runner_call_started'>): RunningOperation {
  const runnerName = cleanOptionalOperationText(event.runnerName);
  const model = cleanOptionalOperationText(event.model);
  return {
    callId: event.callId,
    role: event.role,
    phase: event.phase,
    label: labelForRunnerEvent(event),
    status: 'running',
    startedAt: event.ts,
    endedAt: null,
    durationMs: null,
    reason: null,
    usage: null,
    warnings: [],
    partial: false,
    ...(event.taskId !== undefined && { taskId: event.taskId }),
    ...(runnerName !== undefined && { runnerName }),
    ...(model !== undefined && { model }),
    ...(event.attempt !== undefined && { attempt: event.attempt }),
  };
}

function terminalizeOperation(
  operation: ActiveOperation,
  update: TerminalUpdate,
): TerminalOperation {
  if (operation.status !== 'running') return operation;
  return terminalizeRunningOperation(operation, update);
}

function currentActiveAfterTerminal(
  previousActive: ActiveOperation | null,
  terminalCallId: string,
  byCallId: Map<string, ActiveOperation>,
): ActiveOperation | null {
  if (
    previousActive &&
    previousActive.callId !== terminalCallId &&
    previousActive.status === 'running'
  ) {
    return previousActive;
  }
  return newestRunningOperation(byCallId);
}

function newestRunningOperation(byCallId: Map<string, ActiveOperation>): RunningOperation | null {
  let newest: RunningOperation | null = null;
  for (const operation of byCallId.values()) {
    if (operation.status !== 'running') continue;
    if (!newest || operation.startedAt >= newest.startedAt) newest = operation;
  }
  return newest;
}

function labelForRunnerEvent(event: EngineEventOf<'runner_call_started'>): string {
  const runner = [event.runnerName, event.model]
    .map(cleanOptionalOperationText)
    .filter((part) => part !== undefined)
    .join(' ');
  return cleanOperationText(
    runner ? `${event.role} ${event.phase} (${runner})` : `${event.role} ${event.phase}`,
  );
}
