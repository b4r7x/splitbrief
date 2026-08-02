import type { Phase } from '../../../core/schemas/enums.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { isLivePhase } from '../../../core/phases.js';
import {
  cleanOperationText,
  cleanOptionalOperationText,
  durationBetween,
} from './operation-text.js';
import { compactOperationsState } from './retention.js';
import { replaceOperation, terminalizeRunningOperation } from './runner.js';
import type { OperationsState, RunningOperation } from './state.js';

const PLANNER_STATUS_FALLBACK_PREFIX = 'planner-status:';

function plannerStatusFallbackCallId(phase: Phase): string {
  return `${PLANNER_STATUS_FALLBACK_PREFIX}${phase}`;
}

export function closePlannerStatusFallbacks(state: OperationsState, ts: number): OperationsState {
  let next = state;
  for (const operation of state.byCallId.values()) {
    if (
      operation.status !== 'running' ||
      !operation.callId.startsWith(PLANNER_STATUS_FALLBACK_PREFIX)
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

export function updatePlannerStatusFallback(
  state: OperationsState,
  event: EngineEventOf<'planner_status'>,
): OperationsState {
  if (event.status === 'running' && !isLivePhase(event.phase)) {
    return closePlannerStatusFallbacks(state, event.ts);
  }

  const callId = plannerStatusFallbackCallId(event.phase);
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
    !state.active.callId.startsWith(PLANNER_STATUS_FALLBACK_PREFIX)
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
