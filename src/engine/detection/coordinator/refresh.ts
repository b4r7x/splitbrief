import {
  detectionSourceContextKey,
  type DetectionSourceOutcome,
  type DetectionSourceRequest,
} from '../types.js';
import {
  failureOutcome,
  loadedOutcome,
  noRun,
  offlineOutcome,
  supersededOutcome,
} from './outcomes.js';
import { cloneSnapshot, freshSnapshot, withinTtl } from './snapshots.js';
import type { DetectionCoordinatorState, PendingRequest } from './types.js';

export function supersede(state: DetectionCoordinatorState, request: PendingRequest): void {
  request.superseded = true;
  request.controller.abort();
  if (state.activeBySource.get(request.source) === request)
    state.activeBySource.delete(request.source);
}

function requestCanPublish(state: DetectionCoordinatorState, request: PendingRequest): boolean {
  return (
    !request.cancelled &&
    !request.superseded &&
    state.activeContexts.get(request.source) === request.contextKey &&
    state.activeBySource.get(request.source) === request
  );
}

async function perform(
  state: DetectionCoordinatorState,
  request: PendingRequest,
  input: DetectionSourceRequest,
): Promise<DetectionSourceOutcome<object>> {
  try {
    const value = await input.load(request.controller.signal);
    if (!requestCanPublish(state, request)) return supersededOutcome(request);
    return loadedOutcome(state, request, input, value);
  } catch (cause) {
    if (!requestCanPublish(state, request)) return supersededOutcome(request);
    return failureOutcome(state, request, input, cause);
  }
}

export function refreshSource(
  state: DetectionCoordinatorState,
  input: DetectionSourceRequest,
): Promise<DetectionSourceOutcome<object>> {
  if (state.stopped) {
    return Promise.resolve(
      noRun({ source: input.source, contextKey: input.contextKey, reason: 'cancelled' }),
    );
  }
  const scopeKey = detectionSourceContextKey({
    source: input.source,
    contextKey: input.contextKey,
  });
  const active = state.activeBySource.get(input.source);
  if (active !== undefined && active.contextKey !== input.contextKey) supersede(state, active);
  state.activeContexts.set(input.source, input.contextKey);

  const checkedAt = state.now();
  if (input.offline === true) {
    return Promise.resolve(
      offlineOutcome(state, {
        source: input.source,
        contextKey: input.contextKey,
        scopeKey,
        checkedAt,
      }),
    );
  }

  const pending = state.pendingByScope.get(scopeKey);
  if (
    pending !== undefined &&
    !pending.superseded &&
    state.activeBySource.get(input.source) === pending &&
    pending.promise !== undefined
  ) {
    return pending.promise;
  }

  const previous = state.snapshots.get(scopeKey);
  if (
    input.mode === 'automatic' &&
    previous !== undefined &&
    freshSnapshot(previous) &&
    withinTtl({ snapshot: previous, now: checkedAt, ttlMs: input.ttlMs })
  ) {
    return Promise.resolve({
      kind: 'fresh',
      origin: 'snapshot',
      snapshot: cloneSnapshot(previous),
    });
  }

  const request: PendingRequest = {
    source: input.source,
    contextKey: input.contextKey,
    scopeKey,
    generation: state.nextGeneration + 1,
    requestId: state.nextRequestId + 1,
    controller: new AbortController(),
    cancelled: false,
    superseded: false,
    promise: undefined,
  };
  state.nextGeneration = request.generation;
  state.nextRequestId = request.requestId;
  state.activeBySource.set(input.source, request);
  state.pendingByScope.set(scopeKey, request);
  request.promise = perform(state, request, input).finally(() => {
    if (state.pendingByScope.get(scopeKey) === request) state.pendingByScope.delete(scopeKey);
    if (state.activeBySource.get(input.source) === request)
      state.activeBySource.delete(input.source);
  });
  return request.promise;
}

export function stopRefreshes(state: DetectionCoordinatorState): void {
  state.stopped = true;
  for (const [source, request] of state.activeBySource) {
    request.cancelled = true;
    request.controller.abort();
    state.activeBySource.delete(source);
  }
}
