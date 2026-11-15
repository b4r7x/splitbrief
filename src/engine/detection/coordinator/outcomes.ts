import type {
  DetectionSourceId,
  DetectionSourceOutcome,
  DetectionSourceRequest,
  DetectionSourceSnapshot,
} from '../types.js';
import {
  cloneError,
  cloneSnapshot,
  copySourceValue,
  offlineError,
  staleSnapshot,
} from './snapshots.js';
import type { DetectionCoordinatorState, PendingRequest } from './types.js';

export function noRun(
  input: Readonly<{
    source: DetectionSourceId;
    contextKey: string;
    reason: 'offline' | 'cancelled' | 'superseded';
  }>,
): DetectionSourceOutcome<object> {
  return {
    kind: 'not-run',
    source: input.source,
    contextKey: input.contextKey,
    reason: input.reason,
  };
}

export function offlineOutcome(
  state: DetectionCoordinatorState,
  input: Readonly<{
    source: DetectionSourceId;
    contextKey: string;
    scopeKey: string;
    checkedAt: number;
  }>,
): DetectionSourceOutcome<object> {
  const previous = state.snapshots.get(input.scopeKey);
  if (previous === undefined) {
    return noRun({ source: input.source, contextKey: input.contextKey, reason: 'offline' });
  }

  const snapshot = staleSnapshot({
    snapshot: previous,
    generation: previous.generation,
    requestId: previous.requestId,
    validatedAt: input.checkedAt,
    error: offlineError(),
  });
  state.snapshots.set(input.scopeKey, snapshot);
  return { kind: 'stale', snapshot: cloneSnapshot(snapshot) };
}

export function supersededOutcome(request: PendingRequest): DetectionSourceOutcome<object> {
  if (request.cancelled) {
    return noRun({
      source: request.source,
      contextKey: request.contextKey,
      reason: 'cancelled',
    });
  }
  return noRun({
    source: request.source,
    contextKey: request.contextKey,
    reason: 'superseded',
  });
}

export function loadedOutcome(
  state: DetectionCoordinatorState,
  request: PendingRequest,
  input: DetectionSourceRequest,
  value: object,
): DetectionSourceOutcome<object> {
  const observedAt = state.now();
  const snapshot: DetectionSourceSnapshot<object> = {
    source: input.source,
    contextKey: input.contextKey,
    generation: request.generation,
    requestId: request.requestId,
    fetchedAt: observedAt,
    validatedAt: observedAt,
    stale: false,
    value: copySourceValue(input.source, value),
  };
  state.snapshots.set(request.scopeKey, snapshot);
  return { kind: 'fresh', origin: 'request', snapshot: cloneSnapshot(snapshot) };
}

export function failureOutcome(
  state: DetectionCoordinatorState,
  request: PendingRequest,
  input: DetectionSourceRequest,
  cause: unknown,
): DetectionSourceOutcome<object> {
  const checkedAt = state.now();
  const error = input.error(cause);
  const previous = state.snapshots.get(request.scopeKey);
  if (previous === undefined) {
    return {
      kind: 'failed',
      source: input.source,
      contextKey: input.contextKey,
      generation: request.generation,
      requestId: request.requestId,
      checkedAt,
      error: cloneError(error),
    };
  }

  const snapshot = staleSnapshot({
    snapshot: previous,
    generation: request.generation,
    requestId: request.requestId,
    validatedAt: checkedAt,
    error,
  });
  state.snapshots.set(request.scopeKey, snapshot);
  return { kind: 'stale', snapshot: cloneSnapshot(snapshot) };
}
