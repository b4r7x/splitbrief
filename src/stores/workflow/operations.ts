import type { Phase } from '../../core/schemas/enums.js';
import type { EngineEvent, EngineEventOf } from '../../engine/events/types.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { assertNever } from '../../utils/type-guards.js';
import { createStore, storeBase } from '../create-store.js';

export type OperationStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'aborted'
  | 'timeout';

type TerminalOperationStatus = Exclude<OperationStatus, 'running'>;

export type OperationRole = EngineEventOf<'runner_call_started'>['role'];

interface OperationBase {
  callId: string;
  role: OperationRole;
  phase: Phase;
  taskId?: string;
  label: string;
  runnerName?: string;
  model?: string;
  attempt?: number;
  startedAt: number;
  reason: string | null;
  usage: unknown | null;
  warnings: readonly string[];
}

interface RunningOperation extends OperationBase {
  status: 'running';
  endedAt: null;
  durationMs: null;
  partial: false;
  reason: null;
}

interface TerminalOperation extends OperationBase {
  status: TerminalOperationStatus;
  endedAt: number;
  durationMs: number;
  partial: boolean;
}

export type ActiveOperation = RunningOperation | TerminalOperation;

export interface OperationsState {
  active: ActiveOperation | null;
  last: ActiveOperation | null;
  byCallId: Map<string, ActiveOperation>;
}

interface OperationCancellation {
  ts: number;
  reason: string;
}

const initial = (): OperationsState => ({
  active: null,
  last: null,
  byCallId: new Map(),
});

const LEGACY_PLANNER_STATUS_PREFIX = 'planner-status:';
const MAX_WARNINGS = 20;

const store = createStore<OperationsState>(initial);

function __testReset(next?: Partial<OperationsState>): void {
  store.set(next ? { ...initial(), ...next } : initial());
}

export const _operationsInternal = { set: store.set };

export const operationsStore = {
  ...storeBase(store),
  __testReset,
};

export function updateOperations(state: OperationsState, event: EngineEvent): OperationsState {
  switch (event.type) {
    case 'runner_call_started':
      return startRunnerOperation(closePlannerStatusFallback(state, event.ts), event);
    case 'runner_call_usage':
      return updateKnownOperation(state, event.callId, (operation) => ({
        ...operation,
        usage: event.usage,
      }));
    case 'runner_call_warning':
      return updateKnownOperation(state, event.callId, (operation) => ({
        ...operation,
        warnings: appendWarning(operation.warnings, event.warning.message),
      }));
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
  cancellation: OperationCancellation,
): OperationsState {
  return cancelRunningOperations(state, cancellation);
}

function startRunnerOperation(
  state: OperationsState,
  event: EngineEventOf<'runner_call_started'>,
): OperationsState {
  const operation = operationFromRunnerStart(event);
  const byCallId = new Map(state.byCallId);
  byCallId.set(operation.callId, operation);
  return { ...state, active: operation, byCallId };
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

function updatePlannerStatusFallback(
  state: OperationsState,
  event: EngineEventOf<'planner_status'>,
): OperationsState {
  const callId = legacyPlannerStatusCallId(event.phase);
  if (event.status === 'done') {
    const operation = state.byCallId.get(callId);
    if (!operation || operation.status !== 'running') return state;
    return replaceOperation(
      state,
      terminalizeRunningOperation(operation, {
        status: 'completed',
        endedAt: event.ts,
        durationMs: durationBetween(operation.startedAt, event.ts),
        reason: null,
        usage: null,
        partial: false,
      }),
    );
  }

  if (
    state.active?.status === 'running' &&
    !state.active.callId.startsWith(LEGACY_PLANNER_STATUS_PREFIX)
  ) {
    return state;
  }

  const runnerName = cleanOptionalOperationText(event.tool);
  const model = cleanOptionalOperationText(event.model);
  const operation: RunningOperation = {
    callId,
    role: 'planner',
    phase: event.phase,
    label: cleanOperationText(`planner ${event.phase}`),
    status: 'running',
    startedAt: event.ts,
    endedAt: null,
    durationMs: null,
    reason: null,
    usage: null,
    warnings: [],
    partial: false,
    ...(runnerName !== undefined && { runnerName }),
    ...(model !== undefined && { model }),
  };
  const byCallId = new Map(state.byCallId);
  byCallId.set(operation.callId, operation);
  return { ...state, active: operation, byCallId };
}

function closePlannerStatusFallback(state: OperationsState, ts: number): OperationsState {
  const active = state.active;
  if (
    !active ||
    active.status !== 'running' ||
    !active.callId.startsWith(LEGACY_PLANNER_STATUS_PREFIX)
  ) {
    return state;
  }
  return replaceOperation(
    state,
    terminalizeRunningOperation(active, {
      status: 'completed',
      endedAt: ts,
      durationMs: durationBetween(active.startedAt, ts),
      reason: null,
      usage: active.usage,
      partial: false,
    }),
  );
}

interface TerminalUpdate {
  status: TerminalOperationStatus;
  endedAt: number;
  durationMs: number;
  reason: string | null;
  usage: unknown | null;
  partial: boolean;
}

function terminalizeKnownOperation(
  state: OperationsState,
  callId: string,
  update: TerminalUpdate,
): OperationsState {
  const operation = state.byCallId.get(callId);
  if (!operation) return state;
  return replaceOperation(state, terminalizeOperation(operation, update));
}

function terminalizeOperation(
  operation: ActiveOperation,
  update: TerminalUpdate,
): TerminalOperation {
  if (operation.status !== 'running') {
    return {
      ...operation,
      partial: operation.partial || update.partial,
      reason: operation.reason ?? cleanOperationReason(update.reason),
      usage: update.usage ?? operation.usage,
    };
  }
  return terminalizeRunningOperation(operation, update);
}

function terminalizeRunningOperation(
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

function cancelRunningOperations(
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
  return { ...state, active: null, last, byCallId };
}

function updateKnownOperation(
  state: OperationsState,
  callId: string,
  update: (operation: ActiveOperation) => ActiveOperation,
): OperationsState {
  const operation = state.byCallId.get(callId);
  if (!operation) return state;
  return replaceOperation(state, update(operation));
}

function replaceOperation(state: OperationsState, operation: ActiveOperation): OperationsState {
  const byCallId = new Map(state.byCallId);
  byCallId.set(operation.callId, operation);
  const active =
    operation.status === 'running' ? operation : currentActiveAfterTerminal(state, operation);
  const last = operation.status === 'running' ? state.last : operation;
  return { ...state, active, last, byCallId };
}

function currentActiveAfterTerminal(
  state: OperationsState,
  operation: ActiveOperation,
): ActiveOperation | null {
  if (state.active?.callId === operation.callId) return null;
  return state.active;
}

function operationStatusFromFailure(
  status: EngineEventOf<'runner_call_error'>['status'],
): TerminalOperationStatus {
  switch (status) {
    case 'aborted':
      return 'aborted';
    case 'timeout':
      return 'timeout';
    case 'failed':
    case 'truncated':
    case 'refused':
    case 'unsupported_tool':
    case 'incomplete':
      return 'failed';
    default:
      return assertNever(status);
  }
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

function appendWarning(warnings: readonly string[], warning: string): readonly string[] {
  return [...warnings, cleanOperationText(warning)].slice(-MAX_WARNINGS);
}

function durationBetween(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt);
}

function legacyPlannerStatusCallId(phase: Phase): string {
  return `${LEGACY_PLANNER_STATUS_PREFIX}${phase}`;
}

function cleanOptionalOperationText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = cleanOperationText(value);
  return clean.length === 0 ? undefined : clean;
}

function cleanOperationReason(value: string | null): string | null {
  if (value === null) return null;
  return cleanOperationText(value);
}

function cleanOperationText(value: string): string {
  return sanitizeTerminalDisplayText(value);
}
