import { createStore, storeBase } from '../../create-store.js';
import type {
  CliToolDetection,
  DetectedModel,
  ProviderDetection,
} from '../../../core/discovery/detection.js';
import {
  cloneCliToolDetection,
  cloneProviderDetection,
} from '../../../core/discovery/clone-detection.js';
import { cloneDetectedModel } from '../../../core/discovery/clone-model.js';
import type { ApiProviderId } from '../../../core/providers/api-provider-catalog.js';
import type { ProviderId } from '../../../core/schemas/enums.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import {
  readClaudeCodeModelOptions,
  type ClaudeCodeModelOption,
} from '../../../core/providers/claude-code-options.js';
import { CLI_TOOL_IDS, type CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import {
  runnerRoleForActiveRole,
  type ActiveRunnerRole,
} from '../../../core/runners/seat-roles.js';
import type { DetectionLanePublication } from '../../../engine/detection/lane-channel.js';
import type { DetectionServiceResult } from '../../../engine/detection/service.js';
import type { ConfiguredProviderRuntime } from '../../../engine/detection/provider-outcomes.js';
import type { ScopedCliCatalogRuntime } from '../../../engine/detection/cli-catalog-outcomes.js';
import { includes } from '../../../utils/type-guards.js';
import { deepFreeze, freezeCatalog, freezeModels, frozenSlice } from './freeze.js';
import { demotedForContextChange, laneApplied, providerModels } from './apply-lanes.js';
import {
  cliCatalogValues,
  cloneScopedCliCatalogRuntime,
  findGenericCliCatalogRuntime,
  findScopedCliCatalogRuntime,
  freezeCliCatalogs,
} from './reconcile-cli-catalogs.js';
import {
  cloneConfiguredProviderRuntime,
  configuredProviderRoleKey,
  configuredProviderValues,
  freezeConfiguredProviders,
} from './reconcile-providers.js';
import {
  initialRefresh,
  laneContext,
  legacyOutcomes,
  sourceContextsMatch,
} from './refresh-lanes.js';
import type {
  DetectionStoreHydration,
  DetectionStoreState,
  DiscoveryRefreshRequest,
  DiscoveryRefreshState,
  DiscoverySourceContexts,
  DiscoverySourceRefresh,
  ModelCacheState,
} from './types.js';

function initialState(): ModelCacheState {
  const refresh = initialRefresh();
  return {
    detection: {
      providers: [],
      cliTools: [],
      providerOutcomes: [],
      cliCatalogOutcomes: [],
      refresh,
    },
    providers: {},
    configuredProviders: {},
    cliCatalogs: {},
    cliCatalogsLoaded: false,
    configuredProvidersLoaded: false,
    modelsDevCatalog: null,
    modelsDevFetchedAt: null,
    refresh,
  };
}

const store = createStore<ModelCacheState>(initialState);
let activeContexts: DiscoverySourceContexts | null = null;
let nextPublicationId = 0;

function publicationIsCurrent(current: ModelCacheState, request: DiscoveryRefreshRequest): boolean {
  return (
    current.refresh.publicationId === request.id &&
    activeContexts !== null &&
    sourceContextsMatch(activeContexts, request.contexts)
  );
}

/** The one writer that rebuilds the frozen `detection` projection. */
function commit(next: ModelCacheState): void {
  const previous = store.get().detection;
  store.set({
    ...next,
    detection: deepFreeze({
      providers: frozenSlice(next.detection.providers, previous.providers, cloneProviderDetection),
      cliTools: frozenSlice(next.detection.cliTools, previous.cliTools, cloneCliToolDetection),
      providerOutcomes: frozenSlice(
        next.detection.providerOutcomes,
        previous.providerOutcomes,
        cloneConfiguredProviderRuntime,
      ),
      cliCatalogOutcomes: frozenSlice(
        next.detection.cliCatalogOutcomes,
        previous.cliCatalogOutcomes,
        cloneScopedCliCatalogRuntime,
      ),
      refresh: next.refresh,
    }),
  });
}

function resetAll(): void {
  activeContexts = null;
  nextPublicationId = 0;
  store.reset();
}

export const modelCacheStore = {
  ...storeBase(store),
  reset: resetAll,

  getDetection(): DetectionStoreState {
    return store.get().detection;
  },

  resetDetection(): void {
    activeContexts = null;
    const current = store.get();
    const refresh = initialRefresh();
    commit({
      ...current,
      detection: {
        providers: [],
        cliTools: [],
        providerOutcomes: [],
        cliCatalogOutcomes: [],
        refresh,
      },
      configuredProviders: {},
      cliCatalogs: {},
      cliCatalogsLoaded: false,
      configuredProvidersLoaded: false,
      refresh,
    });
  },

  setDetection(input: {
    providers: readonly ProviderDetection[];
    cliTools: readonly CliToolDetection[];
    providerOutcomes?: readonly ConfiguredProviderRuntime[] | undefined;
  }): void {
    const current = store.get();
    const providerOutcomes = input.providerOutcomes ?? [];
    commit({
      ...current,
      configuredProviders: freezeConfiguredProviders(providerOutcomes),
      detection: {
        ...current.detection,
        providers: input.providers,
        cliTools: input.cliTools,
        providerOutcomes,
      },
    });
  },

  beginRefresh(input: { contexts: DiscoverySourceContexts }): DiscoveryRefreshRequest {
    const { contexts } = input;
    const contextChanged =
      activeContexts !== null && !sourceContextsMatch(activeContexts, contexts);
    activeContexts = contexts;
    const id = nextPublicationId + 1;
    nextPublicationId = id;
    const current = store.get();
    const base = contextChanged ? demotedForContextChange(current, Date.now()) : current;
    const refresh: DiscoveryRefreshState = {
      ...base.refresh,
      publicationId: id,
      readiness: { ...base.refresh.readiness, refreshing: true },
      modelsDev: { ...base.refresh.modelsDev, refreshing: true },
      cliModels: { ...base.refresh.cliModels, refreshing: true },
    };
    commit({ ...base, refresh });
    return { id, contexts };
  },

  hydrateDetection(input: DetectionStoreHydration): boolean {
    if (activeContexts === null) activeContexts = input.contexts;
    else if (!sourceContextsMatch(activeContexts, input.contexts)) return false;
    const current = store.get();
    if (input.generation < current.refresh.generation) return false;
    const readiness: DiscoverySourceRefresh = {
      outcome: 'stale',
      refreshing: false,
      generation: input.generation,
      requestId: input.requestId,
      fetchedAt: input.fetchedAt,
      validatedAt: input.validatedAt,
      error: null,
    };
    const refresh: DiscoveryRefreshState = {
      ...current.refresh,
      generation: input.generation,
      readiness,
    };
    // Remembered catalogs are presentation-only stale rows; live data already
    // in memory always wins over a disk snapshot.
    const rememberedCatalogs =
      current.cliCatalogsLoaded || input.cliCatalogs === undefined || input.cliCatalogs.length === 0
        ? null
        : input.cliCatalogs.map(
            (entry): ScopedCliCatalogRuntime => ({
              connection: {
                role: entry.role,
                tool: entry.tool,
                contextKey: 'remembered-detection-cache',
              },
              state: 'stale',
              models: entry.models.map(cloneDetectedModel),
              fetchedAt: entry.probedAt,
              validatedAt: input.validatedAt,
            }),
          );
    commit({
      ...current,
      detection: {
        ...current.detection,
        providers: input.providers,
        cliTools: input.cliTools,
        ...(rememberedCatalogs === null ? {} : { cliCatalogOutcomes: rememberedCatalogs }),
      },
      providers:
        current.refresh.readiness.outcome === 'uninitialized'
          ? providerModels(current.providers, input.providers, readiness)
          : current.providers,
      // cliCatalogsLoaded stays false: remembered rows render, but authoritative
      // absence and bundled-default semantics still belong to live lanes only.
      ...(rememberedCatalogs === null
        ? {}
        : { cliCatalogs: freezeCliCatalogs(rememberedCatalogs) }),
      refresh,
    });
    return true;
  },

  /**
   * Progressive publication: one settled lane, scoped to its own source context
   * and its own last generation. Lanes touch disjoint state, so an early
   * models.dev catalog reaches the picker without waiting on the CLI probes.
   */
  publishLane(input: {
    lane: DetectionLanePublication;
    request: DiscoveryRefreshRequest;
  }): boolean {
    const current = store.get();
    if (!publicationIsCurrent(current, input.request)) return false;
    if (laneContext(input.lane) !== input.request.contexts[input.lane.lane]) return false;
    const next = laneApplied(current, input.lane);
    if (next === null) return false;
    commit(next);
    return true;
  },

  /**
   * Atomic publication of a whole result: accepted or rejected as a unit, so a
   * result whose lanes disagree about their source contexts — or whose lanes a
   * newer publication already outran — publishes nothing and says so. Applies
   * the same lane transitions as `publishLane` in one transition.
   */
  publish(input: { result: DetectionServiceResult; request: DiscoveryRefreshRequest }): boolean {
    const current = store.get();
    if (!publicationIsCurrent(current, input.request)) return false;
    const generation = input.result.generation ?? current.refresh.generation + 1;
    if (generation < current.refresh.generation) return false;
    const outcomes =
      input.result.outcomes ?? legacyOutcomes(input.result, input.request.contexts, generation);

    const lanes: readonly DetectionLanePublication[] = [
      { lane: 'readiness', outcome: outcomes.readiness },
      { lane: 'modelsDev', outcome: outcomes.modelsDev },
      { lane: 'cliModels', outcome: outcomes.cliModels },
    ];
    if (lanes.some((lane) => laneContext(lane) !== input.request.contexts[lane.lane])) return false;
    const next = lanes.reduce<ModelCacheState | null>(
      (state, lane) => (state === null ? null : laneApplied(state, lane)),
      current,
    );
    if (next === null) return false;
    // Lanes derive the top-level generation from themselves, so an all-not-run
    // result would leave it behind the generation the caller published under.
    const refresh = { ...next.refresh, generation: Math.max(next.refresh.generation, generation) };
    commit({ ...next, refresh });
    return true;
  },

  setProviderModels(provider: ProviderId, models: DetectedModel[]): void {
    const current = store.get();
    const cache = { models: freezeModels(models), fetchedAt: Date.now(), isStale: false };
    store.set({
      ...current,
      providers: {
        ...current.providers,
        [provider]: cache,
      },
    });
  },

  getProviderModels(provider: ProviderId): readonly DetectedModel[] | null {
    const current = store.get();
    if (includes(CLI_TOOL_IDS, provider)) {
      // Remembered rows are role-scoped and answer only through the scoped
      // lookup, so a role-blind lookup has no answer before a live lane runs.
      if (!current.cliCatalogsLoaded) return null;
      // A generic tool lookup is deliberately denied when planner/implementer
      // or two selected channels make the catalog ambiguous.
      return (
        findGenericCliCatalogRuntime(cliCatalogValues(current.cliCatalogs), provider)?.models ??
        null
      );
    }
    const roleScoped = configuredProviderValues(current.configuredProviders).filter(
      (entry) => entry.connection.provider === provider,
    );
    if (roleScoped.length > 0)
      return roleScoped.length === 1 ? (roleScoped[0]?.models ?? null) : null;
    const cache = current.providers[provider];
    return cache?.models ?? null;
  },

  isProviderModelCacheStale(provider: ProviderId): boolean {
    const current = store.get();
    if (includes(CLI_TOOL_IDS, provider)) {
      // Mirrors getProviderModels: remembered rows never answer a role-blind
      // lookup, so there is nothing whose staleness could be reported.
      if (!current.cliCatalogsLoaded) return false;
      return (
        findGenericCliCatalogRuntime(cliCatalogValues(current.cliCatalogs), provider)?.state ===
        'stale'
      );
    }
    const roleScoped = configuredProviderValues(current.configuredProviders).filter(
      (entry) => entry.connection.provider === provider,
    );
    if (roleScoped.length > 0) {
      return roleScoped.length === 1 && roleScoped[0]?.state === 'stale';
    }
    return current.providers[provider]?.isStale ?? false;
  },

  getScopedProviderRuntime(input: {
    role: ActiveRunnerRole;
    provider: ApiProviderId;
  }): ConfiguredProviderRuntime | null | undefined {
    const current = store.get();
    if (Object.keys(current.configuredProviders).length === 0) return undefined;
    const match =
      current.configuredProviders[
        configuredProviderRoleKey({
          role: runnerRoleForActiveRole(input.role),
          provider: input.provider,
        })
      ];
    // Mirrors the CLI axis: a demoted row still answers, but until a live
    // readiness lane runs under this context absence stays unknown rather than
    // authoritative, so a role the new context has not probed keeps its
    // bundled default.
    if (!current.configuredProvidersLoaded) return match ?? undefined;
    return match ?? null;
  },

  getScopedCliCatalogRuntime(input: {
    role: ActiveRunnerRole;
    tool: CliToolId;
  }): ScopedCliCatalogRuntime | null | undefined {
    const current = store.get();
    const match = findScopedCliCatalogRuntime(cliCatalogValues(current.cliCatalogs), {
      role: runnerRoleForActiveRole(input.role),
      tool: input.tool,
    });
    // Before a live catalog lane completes, a remembered row still answers but
    // absence stays "unknown", never authoritative.
    if (!current.cliCatalogsLoaded) return match ?? undefined;
    return match;
  },

  /**
   * Seeds the catalog from its own disk cache so the model column is populated
   * on the first paint. It never replaces a catalog a live lane delivered, never
   * rewrites a lane that has already spoken, and dates itself by the snapshot.
   */
  hydrateModelsDevCatalog(input: {
    catalog: ModelsDevCatalog;
    fetchedAt: number;
    validatedAt: number;
  }): boolean {
    const current = store.get();
    if (current.modelsDevCatalog !== null) return false;
    const previous = current.refresh.modelsDev;
    const modelsDev: DiscoverySourceRefresh =
      previous.outcome === 'uninitialized'
        ? {
            ...previous,
            outcome: 'stale',
            fetchedAt: input.fetchedAt,
            validatedAt: input.validatedAt,
          }
        : previous;
    const refresh: DiscoveryRefreshState = { ...current.refresh, modelsDev };
    commit({
      ...current,
      modelsDevCatalog: freezeCatalog(input.catalog),
      modelsDevFetchedAt: input.fetchedAt,
      refresh,
    });
    return true;
  },

  getModelsDevCatalog(): ModelsDevCatalog | null {
    return store.get().modelsDevCatalog;
  },

  getClaudeCodeModelOptions(): readonly ClaudeCodeModelOption[] {
    return readClaudeCodeModelOptions();
  },
};
