import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import type { DetectionLanePublication } from '../../../engine/detection/lane-channel.js';
import type { ModelsDevRefreshOutcome } from '../../../engine/detection/models-dev-lane.js';
import type {
  DetectionRefreshOutcomes,
  DetectionServiceResult,
} from '../../../engine/detection/service.js';
import type {
  DetectionSourceError,
  DetectionSourceOutcome,
} from '../../../engine/detection/types.js';
import type {
  DiscoveryRefreshState,
  DiscoverySourceContexts,
  DiscoverySourceRefresh,
} from './types.js';

function initialSource(): DiscoverySourceRefresh {
  return {
    outcome: 'uninitialized',
    refreshing: false,
    generation: null,
    requestId: null,
    fetchedAt: null,
    validatedAt: null,
    error: null,
  };
}

export function initialRefresh(): DiscoveryRefreshState {
  return {
    generation: 0,
    publicationId: 0,
    readiness: initialSource(),
    modelsDev: initialSource(),
    cliModels: initialSource(),
  };
}

function cloneError(error: DetectionSourceError): DetectionSourceError {
  return { kind: error.kind, message: error.message };
}

export function sourceContextsMatch(
  left: DiscoverySourceContexts,
  right: DiscoverySourceContexts,
): boolean {
  return (
    left.readiness === right.readiness &&
    left.modelsDev === right.modelsDev &&
    left.cliModels === right.cliModels
  );
}

function sourceContext<Value extends object>(outcome: DetectionSourceOutcome<Value>): string {
  switch (outcome.kind) {
    case 'fresh':
    case 'stale':
      return outcome.snapshot.contextKey;
    case 'failed':
    case 'not-run':
      return outcome.contextKey;
  }
}

function modelsDevContext(outcome: ModelsDevRefreshOutcome): string {
  switch (outcome.kind) {
    case 'cached':
    case 'fresh':
    case 'not-modified':
    case 'stale':
      return outcome.snapshot.contextKey;
    case 'failed':
    case 'not-run':
      return outcome.contextKey;
  }
}

function sourceGeneration<Value extends object>(
  outcome: DetectionSourceOutcome<Value>,
): number | null {
  switch (outcome.kind) {
    case 'fresh':
    case 'stale':
      return outcome.snapshot.generation;
    case 'failed':
      return outcome.generation;
    case 'not-run':
      return null;
  }
}

function modelsDevGeneration(outcome: ModelsDevRefreshOutcome): number | null {
  switch (outcome.kind) {
    case 'cached':
    case 'fresh':
    case 'not-modified':
    case 'stale':
      return outcome.snapshot.generation;
    case 'failed':
      return outcome.generation;
    case 'not-run':
      return null;
  }
}

export function laneContext(lane: DetectionLanePublication): string {
  switch (lane.lane) {
    case 'readiness':
      return sourceContext(lane.outcome);
    case 'modelsDev':
      return modelsDevContext(lane.outcome);
    case 'cliModels':
      return sourceContext(lane.outcome);
  }
}

export function laneGeneration(lane: DetectionLanePublication): number | null {
  switch (lane.lane) {
    case 'readiness':
      return sourceGeneration(lane.outcome);
    case 'modelsDev':
      return modelsDevGeneration(lane.outcome);
    case 'cliModels':
      return sourceGeneration(lane.outcome);
  }
}

/**
 * The coordinator hands out one monotonic generation across all three sources,
 * so a single refresh produces readiness=5, modelsDev=6, cliModels=7 while the
 * lanes settle out of order. Each lane therefore answers only to its own last
 * generation; a shared guard would let the fastest lane silently reject its
 * slower siblings.
 */
export function laneIsOutdated(
  previous: DiscoverySourceRefresh,
  generation: number | null,
): boolean {
  return generation !== null && previous.generation !== null && generation < previous.generation;
}

export function laneRefreshState(
  current: DiscoveryRefreshState,
  lane: Partial<Pick<DiscoveryRefreshState, 'readiness' | 'modelsDev' | 'cliModels'>>,
): DiscoveryRefreshState {
  const merged = { ...current, ...lane };
  return {
    ...merged,
    generation: Math.max(
      current.generation,
      merged.readiness.generation ?? 0,
      merged.modelsDev.generation ?? 0,
      merged.cliModels.generation ?? 0,
    ),
  };
}

export function sourceRefresh<Value extends object>(
  previous: DiscoverySourceRefresh,
  outcome: DetectionSourceOutcome<Value>,
): DiscoverySourceRefresh {
  switch (outcome.kind) {
    case 'fresh':
      return {
        outcome: 'fresh',
        refreshing: false,
        generation: outcome.snapshot.generation,
        requestId: outcome.snapshot.requestId,
        fetchedAt: outcome.snapshot.fetchedAt,
        validatedAt: outcome.snapshot.validatedAt,
        error: null,
      };
    case 'stale':
      return {
        outcome: 'stale',
        refreshing: false,
        generation: outcome.snapshot.generation,
        requestId: outcome.snapshot.requestId,
        fetchedAt: outcome.snapshot.fetchedAt,
        validatedAt: outcome.snapshot.validatedAt,
        error: outcome.snapshot.error === undefined ? null : cloneError(outcome.snapshot.error),
      };
    case 'failed':
      return {
        ...previous,
        outcome: 'failed',
        refreshing: false,
        generation: outcome.generation,
        requestId: outcome.requestId,
        validatedAt: outcome.checkedAt,
        error: cloneError(outcome.error),
      };
    case 'not-run':
      return { ...previous, outcome: 'not-run', refreshing: false, error: null };
  }
}

export function modelsDevRefresh(
  previous: DiscoverySourceRefresh,
  outcome: ModelsDevRefreshOutcome,
): DiscoverySourceRefresh {
  switch (outcome.kind) {
    case 'cached':
    case 'fresh':
    case 'not-modified':
      return {
        outcome: outcome.kind,
        refreshing: false,
        generation: outcome.snapshot.generation,
        requestId: outcome.snapshot.requestId,
        fetchedAt: outcome.snapshot.fetchedAt,
        validatedAt: outcome.snapshot.validatedAt,
        error: null,
      };
    case 'stale':
      return {
        outcome: 'stale',
        refreshing: false,
        generation: outcome.snapshot.generation,
        requestId: outcome.snapshot.requestId,
        fetchedAt: outcome.snapshot.fetchedAt,
        validatedAt: outcome.snapshot.validatedAt,
        error: cloneError(
          outcome.snapshot.error ?? { kind: 'request-failed', message: outcome.failure.message },
        ),
      };
    case 'failed':
      return {
        ...previous,
        outcome: 'failed',
        refreshing: false,
        generation: outcome.generation,
        requestId: outcome.requestId,
        validatedAt: outcome.checkedAt,
        error: { kind: 'request-failed', message: outcome.failure.message },
      };
    case 'not-run':
      return { ...previous, outcome: 'not-run', refreshing: false, error: null };
  }
}

export function freshness<Value extends object>(
  outcome: DetectionSourceOutcome<Value>,
): Value | null {
  return outcome.kind === 'fresh' || outcome.kind === 'stale' ? outcome.snapshot.value : null;
}

export function modelsDevValue(outcome: ModelsDevRefreshOutcome): ModelsDevCatalog | null {
  switch (outcome.kind) {
    case 'cached':
    case 'fresh':
    case 'not-modified':
    case 'stale':
      return outcome.snapshot.value;
    case 'failed':
    case 'not-run':
      return null;
  }
}

/**
 * A result that predates per-source outcomes still has to answer the per-lane
 * generation guard, so its lanes are stamped with the generation `publish`
 * already resolved for it rather than a zero every real lane would outrank.
 */
export function legacyOutcomes(
  result: DetectionServiceResult,
  contexts: DiscoverySourceContexts,
  generation: number,
): DetectionRefreshOutcomes {
  const snapshot = <Value extends object>(value: Value, contextKey: string) => ({
    generation,
    requestId: generation,
    fetchedAt: Date.now(),
    validatedAt: Date.now(),
    stale: false,
    contextKey,
    value,
  });
  return {
    readiness: {
      kind: 'fresh',
      origin: 'request',
      snapshot: {
        source: 'readiness',
        ...snapshot(
          {
            providers: result.providers,
            cliTools: result.cliTools,
            ...(result.configuredProviderOutcomes === undefined
              ? {}
              : { configuredProviderOutcomes: result.configuredProviderOutcomes }),
          },
          contexts.readiness,
        ),
      },
    },
    modelsDev:
      result.catalog === null
        ? {
            kind: 'not-run',
            source: 'models-dev',
            contextKey: contexts.modelsDev,
            reason: 'uninitialized',
          }
        : {
            kind: 'fresh',
            origin: 'request',
            snapshot: {
              source: 'models-dev',
              ...snapshot(result.catalog, contexts.modelsDev),
            },
          },
    cliModels: {
      kind: 'fresh',
      origin: 'request',
      snapshot: { source: 'cli-models', ...snapshot(result.cliModels, contexts.cliModels) },
    },
  };
}
