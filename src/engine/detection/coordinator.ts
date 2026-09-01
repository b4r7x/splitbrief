import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import {
  type CliModelsSourceHydration,
  type CliModelsSourceRequest,
  type CliModelSnapshot,
  type CreateDetectionCoordinatorOptions,
  type DetectionCoordinator,
  type DetectionProjection,
  type DetectionSourceError,
  detectionSourceContextKey,
  type DetectionSourceHydration,
  type DetectionSourceId,
  type DetectionSourceOutcome,
  type DetectionSourceRequest,
  type DetectionSourceSnapshot,
  type ModelsDevSourceHydration,
  type ModelsDevSourceRequest,
  type ReadinessSourceHydration,
  type ReadinessSourceRequest,
} from './types.js';

function cloneError(error: DetectionSourceError): DetectionSourceError {
  return { kind: error.kind, message: error.message };
}

function cloneSnapshot<Value extends object>(
  snapshot: DetectionSourceSnapshot<Value>,
): DetectionSourceSnapshot<Value> {
  return {
    source: snapshot.source,
    contextKey: snapshot.contextKey,
    generation: snapshot.generation,
    requestId: snapshot.requestId,
    fetchedAt: snapshot.fetchedAt,
    validatedAt: snapshot.validatedAt,
    stale: snapshot.stale,
    value: structuredClone(snapshot.value),
    ...(snapshot.error === undefined ? {} : { error: cloneError(snapshot.error) }),
  };
}

function freshSnapshot(snapshot: DetectionSourceSnapshot<object>): boolean {
  return !snapshot.stale;
}

function withinTtl(
  input: Readonly<{ snapshot: DetectionSourceSnapshot<object>; now: number; ttlMs: number }>,
): boolean {
  return input.now - input.snapshot.fetchedAt < Math.max(0, input.ttlMs);
}

function staleSnapshot(
  input: Readonly<{
    snapshot: DetectionSourceSnapshot<object>;
    generation: number;
    requestId: number;
    validatedAt: number;
    error: DetectionSourceError;
  }>,
): DetectionSourceSnapshot<object> {
  return {
    source: input.snapshot.source,
    contextKey: input.snapshot.contextKey,
    generation: input.generation,
    requestId: input.requestId,
    fetchedAt: input.snapshot.fetchedAt,
    validatedAt: input.validatedAt,
    stale: true,
    value: structuredClone(input.snapshot.value),
    error: cloneError(input.error),
  };
}

function offlineError(): DetectionSourceError {
  return { kind: 'offline', message: 'Discovery is offline.' };
}

interface PendingRequest {
  readonly source: DetectionSourceId;
  readonly contextKey: string;
  readonly scopeKey: string;
  readonly generation: number;
  readonly requestId: number;
  readonly controller: AbortController;
  cancelled: boolean;
  superseded: boolean;
  promise: Promise<DetectionSourceOutcome<object>> | undefined;
}

export function createDetectionCoordinator(
  options: CreateDetectionCoordinatorOptions = {},
): DetectionCoordinator {
  const now = options.now ?? Date.now;
  const snapshots = new Map<string, DetectionSourceSnapshot<object>>();
  const activeContexts = new Map<DetectionSourceId, string>();
  const pendingByScope = new Map<string, PendingRequest>();
  const activeBySource = new Map<DetectionSourceId, PendingRequest>();
  let nextGeneration = 0;
  let nextRequestId = 0;

  function supersede(request: PendingRequest): void {
    request.superseded = true;
    request.controller.abort();
    if (activeBySource.get(request.source) === request) activeBySource.delete(request.source);
  }

  function noRun(
    input: Readonly<{
      source: DetectionSourceId;
      contextKey: string;
      reason: 'offline' | 'cancelled' | 'superseded' | 'uninitialized';
    }>,
  ): DetectionSourceOutcome<object> {
    return {
      kind: 'not-run',
      source: input.source,
      contextKey: input.contextKey,
      reason: input.reason,
    };
  }

  function offlineOutcome(
    input: Readonly<{
      source: DetectionSourceId;
      contextKey: string;
      scopeKey: string;
      checkedAt: number;
    }>,
  ): DetectionSourceOutcome<object> {
    const previous = snapshots.get(input.scopeKey);
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
    snapshots.set(input.scopeKey, snapshot);
    return { kind: 'stale', snapshot: cloneSnapshot(snapshot) };
  }

  function supersededOutcome(request: PendingRequest): DetectionSourceOutcome<object> {
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

  function requestCanPublish(request: PendingRequest): boolean {
    return (
      !request.cancelled &&
      !request.superseded &&
      activeContexts.get(request.source) === request.contextKey &&
      activeBySource.get(request.source) === request
    );
  }

  async function perform(
    request: PendingRequest,
    input: DetectionSourceRequest,
  ): Promise<DetectionSourceOutcome<object>> {
    try {
      const value = await input.load(request.controller.signal);
      if (!requestCanPublish(request)) return supersededOutcome(request);

      const observedAt = now();
      const snapshot: DetectionSourceSnapshot<object> = {
        source: input.source,
        contextKey: input.contextKey,
        generation: request.generation,
        requestId: request.requestId,
        fetchedAt: observedAt,
        validatedAt: observedAt,
        stale: false,
        value: structuredClone(value),
      };
      snapshots.set(request.scopeKey, snapshot);
      return { kind: 'fresh', origin: 'request', snapshot: cloneSnapshot(snapshot) };
    } catch (cause) {
      if (!requestCanPublish(request)) return supersededOutcome(request);

      const checkedAt = now();
      const error = input.error(cause);
      const previous = snapshots.get(request.scopeKey);
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
      snapshots.set(request.scopeKey, snapshot);
      return { kind: 'stale', snapshot: cloneSnapshot(snapshot) };
    }
  }

  function refresh(
    input: ReadinessSourceRequest,
  ): Promise<DetectionSourceOutcome<DetectionProjection>>;
  function refresh(
    input: ModelsDevSourceRequest,
  ): Promise<DetectionSourceOutcome<ModelsDevCatalog>>;
  function refresh(
    input: CliModelsSourceRequest,
  ): Promise<DetectionSourceOutcome<CliModelSnapshot>>;
  function refresh(input: DetectionSourceRequest): Promise<DetectionSourceOutcome<object>> {
    const scopeKey = detectionSourceContextKey({
      source: input.source,
      contextKey: input.contextKey,
    });
    const active = activeBySource.get(input.source);
    if (active !== undefined && active.contextKey !== input.contextKey) supersede(active);
    activeContexts.set(input.source, input.contextKey);

    const checkedAt = now();
    if (input.offline === true) {
      return Promise.resolve(
        offlineOutcome({
          source: input.source,
          contextKey: input.contextKey,
          scopeKey,
          checkedAt,
        }),
      );
    }

    const pending = pendingByScope.get(scopeKey);
    if (
      pending !== undefined &&
      !pending.cancelled &&
      !pending.superseded &&
      activeBySource.get(input.source) === pending &&
      pending.promise !== undefined
    ) {
      return pending.promise;
    }

    const previous = snapshots.get(scopeKey);
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
      generation: nextGeneration + 1,
      requestId: nextRequestId + 1,
      controller: new AbortController(),
      cancelled: false,
      superseded: false,
      promise: undefined,
    };
    nextGeneration = request.generation;
    nextRequestId = request.requestId;
    activeBySource.set(input.source, request);
    pendingByScope.set(scopeKey, request);
    request.promise = perform(request, input).finally(() => {
      if (pendingByScope.get(scopeKey) === request) pendingByScope.delete(scopeKey);
      if (activeBySource.get(input.source) === request) activeBySource.delete(input.source);
    });
    return request.promise;
  }

  function snapshot(
    input: Readonly<{
      source: 'readiness';
      contextKey: string;
    }>,
  ): DetectionSourceSnapshot<DetectionProjection> | undefined;
  function snapshot(
    input: Readonly<{
      source: 'models-dev';
      contextKey: string;
    }>,
  ): DetectionSourceSnapshot<ModelsDevCatalog> | undefined;
  function snapshot(
    input: Readonly<{
      source: 'cli-models';
      contextKey: string;
    }>,
  ): DetectionSourceSnapshot<CliModelSnapshot> | undefined;
  function snapshot(
    input: Readonly<{
      source: DetectionSourceId;
      contextKey: string;
    }>,
  ): DetectionSourceSnapshot<object> | undefined {
    const found = snapshots.get(detectionSourceContextKey(input));
    return found === undefined ? undefined : cloneSnapshot(found);
  }

  function cancel(
    input: Readonly<{
      source: DetectionSourceId;
      contextKey?: string | undefined;
    }>,
  ): void {
    const active = activeBySource.get(input.source);
    if (active === undefined) return;
    if (input.contextKey !== undefined && active.contextKey !== input.contextKey) return;

    active.cancelled = true;
    active.controller.abort();
    if (activeBySource.get(input.source) === active) activeBySource.delete(input.source);
  }

  function invalidate(
    input: Readonly<{
      source: DetectionSourceId;
      contextKey?: string | undefined;
    }>,
  ): void {
    const active = activeBySource.get(input.source);
    if (
      active !== undefined &&
      (input.contextKey === undefined || active.contextKey === input.contextKey)
    ) {
      supersede(active);
    }

    if (input.contextKey !== undefined) {
      snapshots.delete(
        detectionSourceContextKey({ source: input.source, contextKey: input.contextKey }),
      );
      return;
    }

    for (const [scopeKey, snapshot] of snapshots) {
      if (snapshot.source === input.source) snapshots.delete(scopeKey);
    }
  }

  function hydrate(input: ReadinessSourceHydration): void;
  function hydrate(input: ModelsDevSourceHydration): void;
  function hydrate(input: CliModelsSourceHydration): void;
  function hydrate(input: DetectionSourceHydration): void {
    const active = activeBySource.get(input.source);
    if (active !== undefined && active.contextKey !== input.contextKey) supersede(active);
    activeContexts.set(input.source, input.contextKey);

    const generation = input.generation ?? nextGeneration + 1;
    const requestId = input.requestId ?? nextRequestId + 1;
    nextGeneration = Math.max(nextGeneration, generation);
    nextRequestId = Math.max(nextRequestId, requestId);
    const snapshot: DetectionSourceSnapshot<object> = {
      source: input.source,
      contextKey: input.contextKey,
      generation,
      requestId,
      fetchedAt: input.fetchedAt,
      validatedAt: input.validatedAt,
      stale: input.stale ?? false,
      value: structuredClone(input.value),
      ...(input.error === undefined ? {} : { error: cloneError(input.error) }),
    };
    snapshots.set(detectionSourceContextKey(input), snapshot);
  }

  return { refresh, snapshot, cancel, invalidate, hydrate };
}
