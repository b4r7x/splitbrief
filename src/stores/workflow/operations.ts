import type { Phase } from '../../core/schemas/enums.js';
import type { EngineEvent, EngineEventOf } from '../../engine/events/types.js';
import { isLivePhase } from '../../core/phases.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { assertNever } from '../../utils/type-guards.js';
import { createStore, storeBase } from '../create-store.js';

type RunnerCallFailureStatus = EngineEventOf<'runner_call_error'>['status'];

export type OperationStatus = 'running' | 'completed' | 'cancelled' | RunnerCallFailureStatus;

type TerminalOperationStatus = Exclude<OperationStatus, 'running'>;

export type OperationRole = EngineEventOf<'runner_call_started'>['role'];
export type OperationWarningSeverity = EngineEventOf<'runner_call_warning'>['warning']['severity'];

export interface OperationWarningGroup {
  code: string;
  severity: OperationWarningSeverity;
  source: string;
  surface: EngineEventOf<'runner_call_warning'>['warning']['surface'];
  fingerprint: string;
  count: number;
  firstTs: number;
  lastTs: number;
  latestMessage: string;
}

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
  warnings: readonly OperationWarningGroup[];
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
export const MAX_COMPLETED_OPERATIONS = 64;

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
  return compactOperationsState({ ...state, active: operation, byCallId });
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
  if (event.status === 'running' && !isLivePhase(event.phase)) {
    return closePlannerStatusFallbacks(state, event.ts);
  }

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
  const nextState = closePlannerStatusFallbacks(state, event.ts);
  const byCallId = new Map(nextState.byCallId);
  byCallId.set(operation.callId, operation);
  return compactOperationsState({ ...nextState, active: operation, byCallId });
}

function closePlannerStatusFallbacks(state: OperationsState, ts: number): OperationsState {
  let next = state;
  for (const operation of state.byCallId.values()) {
    if (
      operation.status !== 'running' ||
      !operation.callId.startsWith(LEGACY_PLANNER_STATUS_PREFIX)
    ) {
      continue;
    }
    next = replaceOperation(
      next,
      terminalizeRunningOperation(operation, {
        status: 'completed',
        endedAt: ts,
        durationMs: durationBetween(operation.startedAt, ts),
        reason: null,
        usage: operation.usage,
        partial: false,
      }),
    );
  }
  return next;
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
  if (operation.status !== 'running') return operation;
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
  return compactOperationsState({ ...state, active: null, last, byCallId });
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
    operation.status === 'running'
      ? operation
      : currentActiveAfterTerminal(state.active, operation.callId, byCallId);
  const last = operation.status === 'running' ? state.last : operation;
  return compactOperationsState({ ...state, active, last, byCallId });
}

function compactOperationsState(state: OperationsState): OperationsState {
  const byCallId = cappedOperationsByCallId(state.byCallId, state.last);
  return byCallId === state.byCallId ? state : { ...state, byCallId };
}

function cappedOperationsByCallId(
  byCallId: Map<string, ActiveOperation>,
  last: ActiveOperation | null,
): Map<string, ActiveOperation> {
  const terminalOperations = Array.from(byCallId.values()).filter(
    (operation): operation is TerminalOperation => operation.status !== 'running',
  );
  if (terminalOperations.length <= MAX_COMPLETED_OPERATIONS) return byCallId;

  terminalOperations.sort(
    (a, b) =>
      b.endedAt - a.endedAt || b.startedAt - a.startedAt || a.callId.localeCompare(b.callId),
  );
  const retainedTerminalCallIds = new Set(
    terminalOperations.slice(0, MAX_COMPLETED_OPERATIONS).map((operation) => operation.callId),
  );
  if (last !== null && last.status !== 'running') retainedTerminalCallIds.add(last.callId);

  const next = new Map<string, ActiveOperation>();
  for (const [callId, operation] of byCallId) {
    if (operation.status === 'running' || retainedTerminalCallIds.has(callId)) {
      next.set(callId, operation);
    }
  }
  return next.size === byCallId.size ? byCallId : next;
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

function operationStatusFromFailure(
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

function labelForRunnerEvent(event: EngineEventOf<'runner_call_started'>): string {
  const runner = [event.runnerName, event.model]
    .map(cleanOptionalOperationText)
    .filter((part) => part !== undefined)
    .join(' ');
  return cleanOperationText(
    runner ? `${event.role} ${event.phase} (${runner})` : `${event.role} ${event.phase}`,
  );
}

function appendWarning(
  warnings: readonly OperationWarningGroup[],
  warning: EngineEventOf<'runner_call_warning'>['warning'],
  ts: number,
): readonly OperationWarningGroup[] {
  const latestMessage = cleanOperationText(warning.message);
  if (latestMessage.length === 0) return warnings;
  const code = cleanOperationText(warning.code);
  const source = cleanOperationText(warning.source);
  const warningKey = operationWarningGroupKey({
    fingerprint: warning.fingerprint,
    code,
    source,
    surface: warning.surface,
  });

  const existingIndex = warnings.findIndex((item) => operationWarningGroupKey(item) === warningKey);
  if (existingIndex === -1) {
    return [
      ...warnings,
      {
        code,
        severity: warning.severity,
        source,
        surface: warning.surface,
        fingerprint: warning.fingerprint,
        count: 1,
        firstTs: ts,
        lastTs: ts,
        latestMessage,
      },
    ].slice(-MAX_WARNINGS);
  }

  const existing = warnings[existingIndex];
  if (existing === undefined) return warnings;
  return warnings.map((item, index) =>
    index === existingIndex
      ? {
          ...item,
          severity: maxWarningSeverity(item.severity, warning.severity),
          count: item.count + 1,
          lastTs: ts,
          latestMessage,
        }
      : item,
  );
}

function showsWarningOnPrimarySurface(
  warning: EngineEventOf<'runner_call_warning'>['warning'],
): boolean {
  switch (warning.surface) {
    case 'activity':
    case 'status':
    case 'transcript':
      return true;
    case 'debug':
    case 'hidden':
      return false;
    default:
      return assertNever(warning.surface);
  }
}

function operationWarningGroupKey(
  warning: Pick<OperationWarningGroup, 'fingerprint' | 'code' | 'source' | 'surface'>,
): string {
  return `${warning.fingerprint}\0${warning.code}\0${warning.source}\0${warning.surface}`;
}

function maxWarningSeverity(
  current: OperationWarningSeverity,
  next: OperationWarningSeverity,
): OperationWarningSeverity {
  return warningSeverityRank(next) > warningSeverityRank(current) ? next : current;
}

function warningSeverityRank(severity: OperationWarningSeverity): number {
  switch (severity) {
    case 'debug':
      return 0;
    case 'info':
      return 1;
    case 'warning':
      return 2;
    case 'error':
      return 3;
    default:
      return assertNever(severity);
  }
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
