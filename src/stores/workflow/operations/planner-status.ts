import type { EngineEventOf } from '../../../engine/events/types.js';
import { isLivePhase } from '../../../core/phases.js';
import {
  cleanOperationText,
  cleanOptionalOperationText,
  durationBetween,
} from './operation-text.js';
import { compactOperationsState } from './retention.js';
import { replaceOperation, terminalizeRunningOperation } from './runner.js';
import type { ActiveOperation, OperationsState, RunningOperation } from './state.js';

const STATUS_FALLBACK_PREFIX = 'status-fallback:';

export function isStatusFallback(operation: ActiveOperation): boolean {
  return operation.callId.startsWith(STATUS_FALLBACK_PREFIX);
}

export function closeStatusFallbacks(state: OperationsState, ts: number): OperationsState {
  let next = state;
  for (const operation of state.byCallId.values()) {
    if (operation.status !== 'running' || !isStatusFallback(operation)) {
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

export function updateStatusFallback(
  state: OperationsState,
  event: EngineEventOf<'planner_status' | 'review_started' | 'review_completed'>,
): OperationsState {
  const role = event.type === 'planner_status' ? 'planner' : 'review';
  const running =
    event.type === 'review_started' ||
    (event.type === 'planner_status' && event.status === 'running');
  if (running && !isLivePhase(event.phase)) {
    return closeStatusFallbacks(state, event.ts);
  }

  const callId = `${STATUS_FALLBACK_PREFIX}${role}:${event.phase}`;
  if (!running) {
    const next = event.type === 'review_completed' ? { ...state, reviewStage: null } : state;
    const operation = next.byCallId.get(callId);
    if (operation?.status !== 'running') return next;
    return replaceOperation(
      next,
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

  if (state.active?.status === 'running' && !isStatusFallback(state.active)) {
    return state;
  }

  const runnerName = cleanOptionalOperationText(event.tool);
  const model = cleanOptionalOperationText(event.model);
  const operation: RunningOperation = {
    callId,
    role,
    phase: event.phase,
    label: cleanOperationText(`${role} ${event.phase}`),
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
    ...(event.type !== 'planner_status' && event.axes !== undefined && { axes: event.axes }),
  };
  const nextState = closeStatusFallbacks(state, event.ts);
  const byCallId = new Map(nextState.byCallId);
  byCallId.set(operation.callId, operation);
  const next = {
    ...nextState,
    active: operation,
    byCallId,
    ...(role === 'review' && { reviewStage: operation }),
  };
  return compactOperationsState(next);
}
