import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import type { ConfiguredProviderOutcome } from './provider-outcomes.js';
import type { ScopedCliCatalogAttempt } from './cli-catalog-outcomes.js';

export const DETECTION_SOURCE_IDS = ['readiness', 'models-dev', 'cli-models'] as const;
export type DetectionSourceId = (typeof DETECTION_SOURCE_IDS)[number];

export const DETECTION_SOURCE_ERROR_KINDS = [
  'request-failed',
  'invalid-response',
  'missing-credential',
  'invalid-credential',
  'policy-denied',
  'timeout',
  'unsupported',
  'offline',
] as const;
export type DetectionSourceErrorKind = (typeof DETECTION_SOURCE_ERROR_KINDS)[number];

export interface DetectionSourceError {
  readonly kind: DetectionSourceErrorKind;
  readonly message: string;
}

export interface DetectionProjection {
  readonly providers: ProviderDetection[];
  readonly cliTools: CliToolDetection[];
  readonly configuredProviderOutcomes?: readonly ConfiguredProviderOutcome[] | undefined;
}

/** Memory-only, exact role/tool/context catalog probe outcomes. */
export type CliModelSnapshot = readonly ScopedCliCatalogAttempt[];

export interface DetectionSourceSnapshot<Value extends object> {
  readonly source: DetectionSourceId;
  readonly contextKey: string;
  readonly generation: number;
  readonly requestId: number;
  readonly fetchedAt: number;
  readonly validatedAt: number;
  readonly stale: boolean;
  readonly value: Value;
  readonly error?: DetectionSourceError | undefined;
}

export type DetectionSourceOutcome<Value extends object> =
  | Readonly<{
      kind: 'fresh';
      origin: 'request' | 'snapshot';
      snapshot: DetectionSourceSnapshot<Value>;
    }>
  | Readonly<{
      kind: 'stale';
      snapshot: DetectionSourceSnapshot<Value>;
    }>
  | Readonly<{
      kind: 'failed';
      source: DetectionSourceId;
      contextKey: string;
      generation: number;
      requestId: number;
      checkedAt: number;
      error: DetectionSourceError;
    }>
  | Readonly<{
      kind: 'not-run';
      source: DetectionSourceId;
      contextKey: string;
      reason: 'offline' | 'cancelled' | 'superseded' | 'uninitialized';
    }>;

type SourceRequestBase<Value extends object> = Readonly<{
  contextKey: string;
  ttlMs: number;
  mode: 'automatic' | 'manual';
  offline?: boolean | undefined;
  load: (signal: AbortSignal) => Promise<Value>;
  error: (cause: unknown) => DetectionSourceError;
}>;

export type ReadinessSourceRequest = SourceRequestBase<DetectionProjection> &
  Readonly<{ source: 'readiness' }>;

export type ModelsDevSourceRequest = SourceRequestBase<ModelsDevCatalog> &
  Readonly<{ source: 'models-dev' }>;

export type CliModelsSourceRequest = SourceRequestBase<CliModelSnapshot> &
  Readonly<{ source: 'cli-models' }>;

export type DetectionSourceRequest =
  | ReadinessSourceRequest
  | ModelsDevSourceRequest
  | CliModelsSourceRequest;

type SourceHydrationBase<Value extends object> = Readonly<{
  contextKey: string;
  value: Value;
  fetchedAt: number;
  validatedAt: number;
  generation?: number | undefined;
  requestId?: number | undefined;
  stale?: boolean | undefined;
  error?: DetectionSourceError | undefined;
}>;

export type ReadinessSourceHydration = SourceHydrationBase<DetectionProjection> &
  Readonly<{ source: 'readiness' }>;

export type ModelsDevSourceHydration = SourceHydrationBase<ModelsDevCatalog> &
  Readonly<{ source: 'models-dev' }>;

export type CliModelsSourceHydration = SourceHydrationBase<CliModelSnapshot> &
  Readonly<{ source: 'cli-models' }>;

export type DetectionSourceHydration =
  | ReadinessSourceHydration
  | ModelsDevSourceHydration
  | CliModelsSourceHydration;

export interface DetectionCoordinator {
  refresh(input: ReadinessSourceRequest): Promise<DetectionSourceOutcome<DetectionProjection>>;
  refresh(input: ModelsDevSourceRequest): Promise<DetectionSourceOutcome<ModelsDevCatalog>>;
  refresh(input: CliModelsSourceRequest): Promise<DetectionSourceOutcome<CliModelSnapshot>>;
  snapshot(
    input: Readonly<{ source: 'readiness'; contextKey: string }>,
  ): DetectionSourceSnapshot<DetectionProjection> | undefined;
  snapshot(
    input: Readonly<{ source: 'models-dev'; contextKey: string }>,
  ): DetectionSourceSnapshot<ModelsDevCatalog> | undefined;
  snapshot(
    input: Readonly<{ source: 'cli-models'; contextKey: string }>,
  ): DetectionSourceSnapshot<CliModelSnapshot> | undefined;
  cancel(input: Readonly<{ source: DetectionSourceId; contextKey?: string | undefined }>): void;
  invalidate(input: Readonly<{ source: DetectionSourceId; contextKey?: string | undefined }>): void;
  hydrate(input: ReadinessSourceHydration): void;
  hydrate(input: ModelsDevSourceHydration): void;
  hydrate(input: CliModelsSourceHydration): void;
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

export interface CreateDetectionCoordinatorOptions {
  readonly now?: (() => number) | undefined;
}

export interface DetectionContextIdentity {
  readonly platform: string;
  readonly runner: string;
  readonly executableFingerprint?: string | undefined;
  readonly executableVersion?: string | undefined;
  readonly authChannel?: string | undefined;
  readonly endpointOrigin?: string | undefined;
  /** Opaque source/config identity only; never a credential value or hash. */
  readonly credentialDomain?: string | undefined;
  readonly configGeneration: string;
}

export function detectionContextKey(input: DetectionContextIdentity): string {
  return [
    'detection-context-v1',
    input.platform,
    input.runner,
    input.executableFingerprint ?? 'no-executable-fingerprint',
    input.executableVersion ?? 'no-executable-version',
    input.authChannel ?? 'no-auth-channel',
    input.endpointOrigin ?? 'no-endpoint',
    input.credentialDomain ?? 'no-credential-domain',
    input.configGeneration,
  ]
    .map((part) => encodeURIComponent(part))
    .join('|');
}

export function detectionSourceContextKey(
  input: Readonly<{
    source: DetectionSourceId;
    contextKey: string;
  }>,
): string {
  return `${encodeURIComponent(input.source)}|${encodeURIComponent(input.contextKey)}`;
}

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
