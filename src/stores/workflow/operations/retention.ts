import type { ActiveOperation, TerminalOperation } from './state.js';

export const MAX_COMPLETED_OPERATIONS = 64;

export function compactOperationsState(state: {
  active: ActiveOperation | null;
  last: ActiveOperation | null;
  byCallId: Map<string, ActiveOperation>;
}): {
  active: ActiveOperation | null;
  last: ActiveOperation | null;
  byCallId: Map<string, ActiveOperation>;
} {
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
