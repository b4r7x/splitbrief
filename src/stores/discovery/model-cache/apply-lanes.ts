import type { ProviderDetection } from '../../../core/discovery/detection.js';
import { PROVIDER_IDS, type ProviderId } from '../../../core/schemas/enums.js';
import type { DetectionLanePublication } from '../../../engine/detection/lane-channel.js';
import type { ModelsDevRefreshOutcome } from '../../../engine/detection/models-dev-lane.js';
import type {
  CliModelSnapshot,
  DetectionProjection,
  DetectionSourceOutcome,
} from '../../../engine/detection/types.js';
import { freezeCatalog, freezeModels } from './freeze.js';
import {
  configuredProviderValues,
  freezeConfiguredProviders,
  reconcileConfiguredProviderOutcomes,
  staleConfiguredProviderRuntimes,
} from './reconcile-providers.js';
import {
  cliCatalogValues,
  freezeCliCatalogs,
  reconciledCliCatalogs,
  staleCliCatalogRuntimes,
} from './reconcile-cli-catalogs.js';
import {
  freshness,
  laneGeneration,
  laneIsOutdated,
  laneRefreshState,
  modelsDevRefresh,
  modelsDevValue,
  sourceRefresh,
} from './refresh-lanes.js';
import type { DiscoverySourceRefresh, ModelCacheState, ProviderModelCache } from './types.js';

export function providerModels(
  previous: Partial<Record<ProviderId, ProviderModelCache>>,
  providers: readonly ProviderDetection[],
  source: DiscoverySourceRefresh,
): Partial<Record<ProviderId, ProviderModelCache>> {
  if (providers.length === 0) return {};
  const next = { ...previous };
  for (const provider of providers) {
    if (provider.models === undefined) continue;
    next[provider.provider] = {
      models: freezeModels(provider.models),
      fetchedAt: source.fetchedAt,
      isStale: source.outcome === 'stale' || source.outcome === 'failed',
    };
  }
  return next;
}

function staleProviderModelCaches(
  previous: Partial<Record<ProviderId, ProviderModelCache>>,
): Partial<Record<ProviderId, ProviderModelCache>> {
  const next: Partial<Record<ProviderId, ProviderModelCache>> = {};
  for (const provider of PROVIDER_IDS) {
    const cache = previous[provider];
    if (cache !== undefined) next[provider] = { ...cache, isStale: true };
  }
  return next;
}

/**
 * A context change invalidates authority, not memory. Rows are keyed by
 * role + tool, so a remembered `implementer/opencode` catalog is still the right
 * data for `implementer/opencode` after the *planner* changes, and the models.dev
 * catalog never depended on the runner context at all. Demote everything the new
 * context has not re-probed instead of dropping it, so the last known catalog
 * stays on screen while the lanes run. A `failed` row is the exception: it is a
 * verdict with no memory behind it, and a verdict about the previous context
 * would otherwise render as this one's.
 */
export function demotedForContextChange(
  current: ModelCacheState,
  observedAt: number,
): ModelCacheState {
  const providerOutcomes = staleConfiguredProviderRuntimes({
    previous: configuredProviderValues(current.configuredProviders).filter(
      (runtime) => runtime.state !== 'failed',
    ),
    observedAt,
  });
  const cliCatalogOutcomes = staleCliCatalogRuntimes({
    previous: cliCatalogValues(current.cliCatalogs).filter((runtime) => runtime.state !== 'failed'),
    observedAt,
    failure: undefined,
  });
  return {
    ...current,
    detection: { ...current.detection, providerOutcomes, cliCatalogOutcomes },
    providers: staleProviderModelCaches(current.providers),
    configuredProviders: freezeConfiguredProviders(providerOutcomes),
    cliCatalogs: freezeCliCatalogs(cliCatalogOutcomes),
    // Demoted rows render, but authoritative absence and bundled-default
    // semantics still belong to live lanes only.
    cliCatalogsLoaded: false,
    configuredProvidersLoaded: false,
  };
}

function readinessApplied(
  current: ModelCacheState,
  outcome: DetectionSourceOutcome<DetectionProjection>,
): ModelCacheState {
  const readiness = sourceRefresh(current.refresh.readiness, outcome);
  const refresh = laneRefreshState(current.refresh, { readiness });
  const value = freshness(outcome);
  const observedAt = readiness.validatedAt ?? Date.now();
  const previous = configuredProviderValues(current.configuredProviders);
  const configuredProviders = (() => {
    switch (outcome.kind) {
      case 'fresh': {
        const configured = outcome.snapshot.value.configuredProviderOutcomes;
        if (configured === undefined) return current.configuredProviders;
        return freezeConfiguredProviders(
          reconcileConfiguredProviderOutcomes({ previous, outcomes: configured, observedAt }),
        );
      }
      case 'stale': {
        const configured = outcome.snapshot.value.configuredProviderOutcomes;
        if (configured === undefined) return current.configuredProviders;
        return freezeConfiguredProviders(
          staleConfiguredProviderRuntimes({
            previous,
            matchingOutcomes: configured,
            error: outcome.snapshot.error ?? {
              kind: 'request-failed',
              message: 'Runner readiness refresh failed.',
            },
            observedAt,
          }),
        );
      }
      case 'failed':
        return freezeConfiguredProviders(
          staleConfiguredProviderRuntimes({ previous, error: outcome.error, observedAt }),
        );
      case 'not-run':
        return current.configuredProviders;
    }
  })();
  return {
    ...current,
    detection: {
      ...current.detection,
      providers: value === null ? current.detection.providers : value.providers,
      cliTools: value === null ? current.detection.cliTools : value.cliTools,
      providerOutcomes: configuredProviderValues(configuredProviders),
    },
    providers:
      value === null || value.configuredProviderOutcomes !== undefined
        ? current.providers
        : providerModels(current.providers, value.providers, readiness),
    configuredProviders,
    configuredProvidersLoaded: current.configuredProvidersLoaded || outcome.kind !== 'not-run',
    refresh,
  };
}

function modelsDevApplied(
  current: ModelCacheState,
  outcome: ModelsDevRefreshOutcome,
): ModelCacheState {
  const modelsDev = modelsDevRefresh(current.refresh.modelsDev, outcome);
  const refresh = laneRefreshState(current.refresh, { modelsDev });
  const catalog = modelsDevValue(outcome);
  return {
    ...current,
    modelsDevCatalog: catalog === null ? current.modelsDevCatalog : freezeCatalog(catalog),
    modelsDevFetchedAt: catalog === null ? current.modelsDevFetchedAt : modelsDev.fetchedAt,
    refresh,
  };
}

function cliModelsApplied(
  current: ModelCacheState,
  outcome: DetectionSourceOutcome<CliModelSnapshot>,
): ModelCacheState {
  const cliModels = sourceRefresh(current.refresh.cliModels, outcome);
  const refresh = laneRefreshState(current.refresh, { cliModels });
  const cliCatalogOutcomes = reconciledCliCatalogs({
    previous: cliCatalogValues(current.cliCatalogs),
    outcome,
    observedAt: cliModels.validatedAt ?? Date.now(),
  });
  return {
    ...current,
    detection: { ...current.detection, cliCatalogOutcomes },
    cliCatalogs: freezeCliCatalogs(cliCatalogOutcomes),
    cliCatalogsLoaded: current.cliCatalogsLoaded || outcome.kind !== 'not-run',
    refresh,
  };
}

export function laneApplied(
  current: ModelCacheState,
  lane: DetectionLanePublication,
): ModelCacheState | null {
  if (laneIsOutdated(current.refresh[lane.lane], laneGeneration(lane))) return null;
  switch (lane.lane) {
    case 'readiness':
      return readinessApplied(current, lane.outcome);
    case 'modelsDev':
      return modelsDevApplied(current, lane.outcome);
    case 'cliModels':
      return cliModelsApplied(current, lane.outcome);
  }
}
