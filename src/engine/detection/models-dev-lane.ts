import {
  type DetectionCoordinator,
  detectionSourceContextKey,
  type DetectionSourceError,
  type DetectionSourceSnapshot,
} from './types.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import type {
  ModelsDevCacheFailure,
  ModelsDevCatalogCacheOutcome,
  ModelsDevCatalogSnapshot,
} from '../providers/models-dev-cache.js';
import { assertNever } from '../../utils/type-guards.js';
import { throwIfAborted } from '../../utils/abort.js';

export interface ModelsDevCatalogRequest {
  readonly mode: 'automatic' | 'manual';
  readonly signal: AbortSignal;
}

export type ModelsDevCatalogFetchResult = ModelsDevCatalogCacheOutcome | ModelsDevCatalog;

/** The subset of `DetectionDeps` this lane reads; the full deps satisfy it. */
export interface ModelsDevLaneDeps {
  fetchModelsDevCatalog(input: ModelsDevCatalogRequest): Promise<ModelsDevCatalogFetchResult>;
  readonly offline?: boolean | undefined;
}

export type ModelsDevRefreshOutcome =
  | Readonly<{
      kind: 'cached' | 'fresh' | 'not-modified';
      origin: 'request' | 'snapshot';
      snapshot: DetectionSourceSnapshot<ModelsDevCatalog>;
    }>
  | Readonly<{
      kind: 'stale';
      snapshot: DetectionSourceSnapshot<ModelsDevCatalog>;
      failure: ModelsDevCacheFailure;
    }>
  | Readonly<{
      kind: 'failed';
      source: 'models-dev';
      contextKey: string;
      generation: number;
      requestId: number;
      checkedAt: number;
      failure: ModelsDevCacheFailure;
    }>
  | Readonly<{
      kind: 'not-run';
      source: 'models-dev';
      contextKey: string;
      reason: 'offline' | 'cancelled' | 'superseded' | 'uninitialized';
    }>;

type ModelsDevCoordinatorSnapshot = DetectionSourceSnapshot<ModelsDevCatalog> &
  Readonly<{ source: 'models-dev' }>;

const MODELS_DEV_TTL_MS = 15 * 60 * 1_000;

function modelsDevSourceError(failure: ModelsDevCacheFailure): DetectionSourceError {
  switch (failure.kind) {
    case 'timeout':
      return { kind: 'timeout', message: failure.message };
    case 'invalid-json':
    case 'invalid-schema':
    case 'not-modified-without-cache':
    case 'payload-too-large':
      return { kind: 'invalid-response', message: failure.message };
    case 'cache-write-failed':
    case 'http-error':
    case 'request-failed':
      return { kind: 'request-failed', message: failure.message };
    default:
      return assertNever(failure.kind);
  }
}

function catalogState(catalog: ModelsDevCatalog): ModelsDevCatalogSnapshot['catalogState'] {
  return Object.keys(catalog).length === 0 ? 'empty' : 'populated';
}

function isModelsDevCatalogCacheOutcome(
  value: ModelsDevCatalogFetchResult,
): value is ModelsDevCatalogCacheOutcome {
  if (!('kind' in value)) return false;
  switch (value.kind) {
    case 'cached':
    case 'fresh':
    case 'not-modified':
    case 'stale':
    case 'failed':
      return true;
    default:
      return false;
  }
}

function normalizeModelsDevCatalogOutcome(
  input: Readonly<{ value: ModelsDevCatalogFetchResult; observedAt: number }>,
): ModelsDevCatalogCacheOutcome {
  if (isModelsDevCatalogCacheOutcome(input.value)) return input.value;
  return {
    kind: 'fresh',
    snapshot: {
      sourceUrl: 'legacy-detection-dependency',
      parserVersion: 'legacy-detection-dependency',
      catalog: structuredClone(input.value),
      catalogState: catalogState(input.value),
      fetchedAt: input.observedAt,
      validatedAt: input.observedAt,
    },
  };
}

function modelsDevSnapshot(
  input: Readonly<{
    cacheSnapshot: ModelsDevCatalogSnapshot;
    contextKey: string;
    failure?: ModelsDevCacheFailure | undefined;
    generation: number;
    requestId: number;
  }>,
): ModelsDevCoordinatorSnapshot {
  return {
    source: 'models-dev',
    contextKey: input.contextKey,
    generation: input.generation,
    requestId: input.requestId,
    fetchedAt: input.cacheSnapshot.fetchedAt,
    validatedAt: input.cacheSnapshot.validatedAt,
    stale: input.failure !== undefined,
    value: structuredClone(input.cacheSnapshot.catalog),
    ...(input.failure === undefined ? {} : { error: modelsDevSourceError(input.failure) }),
  };
}

export function modelsDevCatalogValue(outcome: ModelsDevRefreshOutcome): ModelsDevCatalog | null {
  switch (outcome.kind) {
    case 'cached':
    case 'fresh':
    case 'not-modified':
    case 'stale':
      return structuredClone(outcome.snapshot.value);
    case 'failed':
    case 'not-run':
      return null;
    default:
      return assertNever(outcome);
  }
}

export async function refreshModelsDev(
  input: Readonly<{
    contextKey: string;
    deps: ModelsDevLaneDeps;
    mode: 'automatic' | 'manual';
    coordinator: DetectionCoordinator;
    cacheOutcomes: Map<string, ModelsDevCatalogCacheOutcome>;
    now: () => number;
  }>,
): Promise<ModelsDevRefreshOutcome> {
  const scopeKey = detectionSourceContextKey({
    source: 'models-dev',
    contextKey: input.contextKey,
  });
  const outer = await input.coordinator.refresh({
    source: 'models-dev',
    contextKey: input.contextKey,
    ttlMs: MODELS_DEV_TTL_MS,
    mode: input.mode,
    offline: input.deps.offline,
    load: async (signal) => {
      let outcome: ModelsDevCatalogCacheOutcome;
      try {
        outcome = normalizeModelsDevCatalogOutcome({
          value: await input.deps.fetchModelsDevCatalog({ mode: input.mode, signal }),
          observedAt: input.now(),
        });
      } catch {
        throwIfAborted(signal);
        outcome = {
          kind: 'failed',
          failure: {
            kind: 'request-failed',
            message: 'Models.dev catalog request failed.',
          },
        };
      }
      input.cacheOutcomes.set(scopeKey, outcome);
      switch (outcome.kind) {
        case 'cached':
        case 'fresh':
        case 'not-modified':
        case 'stale':
          return structuredClone(outcome.snapshot.catalog);
        case 'failed':
          throw outcome.failure;
        default:
          return assertNever(outcome);
      }
    },
    error: () => ({ kind: 'request-failed', message: 'Models.dev catalog request failed.' }),
  });

  if (outer.kind === 'not-run') {
    return {
      kind: 'not-run',
      source: 'models-dev',
      contextKey: outer.contextKey,
      reason: outer.reason,
    };
  }
  const cacheOutcome = input.cacheOutcomes.get(scopeKey);
  if (cacheOutcome === undefined) {
    const failure = {
      kind: 'request-failed' as const,
      message: 'Models.dev catalog request failed.',
    };
    switch (outer.kind) {
      case 'fresh':
        return { kind: 'fresh', origin: outer.origin, snapshot: outer.snapshot };
      case 'stale':
        return { kind: 'stale', snapshot: outer.snapshot, failure };
      case 'failed':
        return {
          kind: 'failed',
          source: 'models-dev',
          contextKey: outer.contextKey,
          generation: outer.generation,
          requestId: outer.requestId,
          checkedAt: outer.checkedAt,
          failure,
        };
      default:
        return assertNever(outer);
    }
  }

  if (cacheOutcome.kind === 'failed') {
    input.coordinator.invalidate({ source: 'models-dev', contextKey: input.contextKey });
    switch (outer.kind) {
      case 'failed':
        return {
          kind: 'failed',
          source: 'models-dev',
          contextKey: outer.contextKey,
          generation: outer.generation,
          requestId: outer.requestId,
          checkedAt: outer.checkedAt,
          failure: cacheOutcome.failure,
        };
      case 'stale':
        return {
          kind: 'failed',
          source: 'models-dev',
          contextKey: outer.snapshot.contextKey,
          generation: outer.snapshot.generation,
          requestId: outer.snapshot.requestId,
          checkedAt: outer.snapshot.validatedAt,
          failure: cacheOutcome.failure,
        };
      case 'fresh':
        return {
          kind: 'failed',
          source: 'models-dev',
          contextKey: outer.snapshot.contextKey,
          generation: outer.snapshot.generation,
          requestId: outer.snapshot.requestId,
          checkedAt: outer.snapshot.validatedAt,
          failure: cacheOutcome.failure,
        };
      default:
        return assertNever(outer);
    }
  }

  const identity =
    outer.kind === 'fresh' || outer.kind === 'stale'
      ? {
          generation: outer.snapshot.generation,
          requestId: outer.snapshot.requestId,
        }
      : {
          generation: outer.generation,
          requestId: outer.requestId,
        };
  const failure = cacheOutcome.kind === 'stale' ? cacheOutcome.failure : undefined;
  const snapshot = modelsDevSnapshot({
    cacheSnapshot: cacheOutcome.snapshot,
    contextKey: input.contextKey,
    failure,
    generation: identity.generation,
    requestId: identity.requestId,
  });
  input.coordinator.hydrate(snapshot);

  switch (cacheOutcome.kind) {
    case 'cached':
    case 'fresh':
    case 'not-modified':
      return {
        kind: cacheOutcome.kind,
        origin:
          cacheOutcome.kind === 'cached'
            ? 'snapshot'
            : outer.kind === 'fresh'
              ? outer.origin
              : 'request',
        snapshot,
      };
    case 'stale':
      return { kind: 'stale', snapshot, failure: cacheOutcome.failure };
  }
}
