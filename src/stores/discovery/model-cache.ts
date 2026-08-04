import { createStore } from '../create-store.js';
import type {
  CliToolDetection,
  DetectedModel,
  ProviderDetection,
} from '../../core/discovery/detection.js';
import { cloneDetectedModel } from '../../core/discovery/clone-model.js';
import type { ActiveRunnerRole } from '../../core/config/accessors/active-runner.js';
import type { ApiProviderId } from '../../core/providers/api-provider-catalog.js';
import { PROVIDER_IDS, type ProviderId } from '../../core/schemas/enums.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import { CLI_TOOL_IDS, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type {
  DetectionLanePublication,
  DetectionRefreshOutcomes,
  DetectionServiceResult,
  ModelsDevRefreshOutcome,
  ResolvedDetectionSourceContexts,
} from '../../engine/detection/service.js';
import type { RememberedCliCatalog } from '../../engine/detection/cache.js';
import type { DetectionPublicationRequest } from '../../engine/detection/store-publication.js';
import type {
  CliModelSnapshot,
  DetectionProjection,
  DetectionSourceError,
  DetectionSourceOutcome,
} from '../../engine/detection/coordinator.js';
import type {
  ScopedCliCatalogAttempt,
  ScopedCliCatalogConnection,
  ScopedCliCatalogRuntime,
} from '../../engine/detection/cli-catalog-outcomes.js';
import type {
  ConfiguredProviderOutcome,
  ConfiguredProviderRuntime,
} from '../../engine/detection/provider-outcomes.js';
import type { ProviderCatalogFailureKind } from '../../engine/providers/types.js';
import { includes } from '../../utils/type-guards.js';

export type DiscoverySourceOutcome =
  | 'uninitialized'
  | 'fresh'
  | 'cached'
  | 'not-modified'
  | 'stale'
  | 'failed'
  | 'not-run';

export interface DiscoverySourceRefresh {
  readonly outcome: DiscoverySourceOutcome;
  readonly refreshing: boolean;
  readonly generation: number | null;
  readonly requestId: number | null;
  readonly fetchedAt: number | null;
  readonly validatedAt: number | null;
  readonly error: DetectionSourceError | null;
}

export interface DiscoveryRefreshState {
  readonly generation: number;
  readonly publicationId: number;
  readonly readiness: DiscoverySourceRefresh;
  readonly modelsDev: DiscoverySourceRefresh;
  readonly cliModels: DiscoverySourceRefresh;
}

export interface DetectionStoreState {
  readonly providers: readonly ProviderDetection[];
  readonly cliTools: readonly CliToolDetection[];
  /** Role-scoped, memory-only API catalog outcomes. */
  readonly providerOutcomes: readonly ConfiguredProviderRuntime[];
  /** Role/tool/context-scoped, memory-only native CLI catalog outcomes. */
  readonly cliCatalogOutcomes: readonly ScopedCliCatalogRuntime[];
  readonly refresh: DiscoveryRefreshState;
}

interface ProviderModelCache {
  readonly models: readonly DetectedModel[];
  readonly fetchedAt: number | null;
  readonly isStale: boolean;
}

interface ModelCacheState {
  readonly detection: DetectionStoreState;
  readonly providers: Partial<Record<ProviderId, ProviderModelCache>>;
  readonly configuredProviders: Readonly<Record<string, ConfiguredProviderRuntime>>;
  readonly cliCatalogs: Readonly<Record<string, ScopedCliCatalogRuntime>>;
  /** False until an authoritative exact-context catalog lane has completed. */
  readonly cliCatalogsLoaded: boolean;
  /** The same rule on the API axis: false until a live readiness lane has run. */
  readonly configuredProvidersLoaded: boolean;
  /** Deprecated generic test/manual injection fallback, never used by discovery. */
  readonly cliModels: Partial<Record<CliToolId, ProviderModelCache>>;
  readonly modelsDevCatalog: ModelsDevCatalog | null;
  readonly modelsDevFetchedAt: number | null;
  readonly refresh: DiscoveryRefreshState;
}

export type DiscoverySourceContexts = ResolvedDetectionSourceContexts;

export type DiscoveryRefreshRequest = DetectionPublicationRequest;

export interface DetectionStoreHydration {
  readonly providers: readonly ProviderDetection[];
  readonly cliTools: readonly CliToolDetection[];
  readonly fetchedAt: number;
  readonly validatedAt: number;
  readonly generation: number;
  readonly requestId: number;
  readonly contexts: DiscoverySourceContexts;
  readonly cliCatalogs?: readonly RememberedCliCatalog[] | undefined;
}

const initialSource = (): DiscoverySourceRefresh => ({
  outcome: 'uninitialized',
  refreshing: false,
  generation: null,
  requestId: null,
  fetchedAt: null,
  validatedAt: null,
  error: null,
});

const initialRefresh = (): DiscoveryRefreshState => ({
  generation: 0,
  publicationId: 0,
  readiness: initialSource(),
  modelsDev: initialSource(),
  cliModels: initialSource(),
});

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
    cliModels: {},
    modelsDevCatalog: null,
    modelsDevFetchedAt: null,
    refresh,
  };
}

const store = createStore<ModelCacheState>(initialState);
let activeContexts: DiscoverySourceContexts | null = null;
let nextPublicationId = 0;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function cloneCliTool(cliTool: CliToolDetection): CliToolDetection {
  return {
    ...cliTool,
    executable:
      cliTool.executable === null
        ? null
        : {
            path: cliTool.executable.path,
            fingerprint: { ...cliTool.executable.fingerprint },
          },
    diagnostic:
      cliTool.diagnostic.state === 'ready'
        ? { state: 'ready', remediation: null }
        : { state: cliTool.diagnostic.state, remediation: cliTool.diagnostic.remediation },
  };
}

function cloneProvider(provider: ProviderDetection): ProviderDetection {
  return {
    ...provider,
    ...(provider.models === undefined ? {} : { models: provider.models.map(cloneDetectedModel) }),
  };
}

/**
 * Stores may depend on engine contracts only through type imports. Keep this
 * small reconciliation adapter at the store boundary so runtime publication
 * remains directed engine → store, never the reverse.
 */
function configuredProviderRoleKey(
  connection: Pick<ConfiguredProviderRuntime['connection'], 'role' | 'provider'>,
): string {
  return `${connection.role}\u0000${connection.provider}`;
}

function configuredProviderConnectionKey(
  connection: ConfiguredProviderRuntime['connection'],
): string {
  return `${configuredProviderRoleKey(connection)}\u0000${connection.contextKey}`;
}

function cloneConfiguredProviderRuntime(
  runtime: ConfiguredProviderRuntime,
): ConfiguredProviderRuntime {
  return {
    connection: { ...runtime.connection },
    state: runtime.state,
    catalog: runtime.catalog,
    models: runtime.models === null ? null : runtime.models.map(cloneDetectedModel),
    fetchedAt: runtime.fetchedAt,
    validatedAt: runtime.validatedAt,
    ...(runtime.failure === undefined ? {} : { failure: runtime.failure }),
    ...(runtime.diagnostic === undefined ? {} : { diagnostic: runtime.diagnostic }),
  };
}

/**
 * Stores may consume engine contracts as types but cannot import engine
 * runtime helpers. Keep this small clone/reconciliation adapter at the store
 * boundary so publication remains engine → store and all persisted state is
 * still exact role/tool/context scoped.
 */
function cliCatalogRoleKey(connection: Pick<ScopedCliCatalogConnection, 'role' | 'tool'>): string {
  return `${connection.role}\u0000${connection.tool}`;
}

function cliCatalogConnectionKey(connection: ScopedCliCatalogConnection): string {
  return `${cliCatalogRoleKey(connection)}\u0000${connection.contextKey}`;
}

function cloneScopedCliCatalogRuntime(runtime: ScopedCliCatalogRuntime): ScopedCliCatalogRuntime {
  return {
    connection: { ...runtime.connection },
    state: runtime.state,
    models: runtime.models === null ? null : runtime.models.map(cloneDetectedModel),
    fetchedAt: runtime.fetchedAt,
    validatedAt: runtime.validatedAt,
    ...(runtime.failure === undefined ? {} : { failure: runtime.failure }),
  };
}

function runtimeFromCliCatalogAttempt(
  input: Readonly<{
    attempt: ScopedCliCatalogAttempt;
    previous: ScopedCliCatalogRuntime | undefined;
    observedAt: number;
  }>,
): ScopedCliCatalogRuntime {
  const { attempt, previous, observedAt } = input;
  if (attempt.outcome.kind === 'success') {
    return {
      connection: { ...attempt.connection },
      state: 'fresh',
      models: attempt.outcome.value.map(cloneDetectedModel),
      fetchedAt: observedAt,
      validatedAt: observedAt,
    };
  }
  if (previous !== undefined && previous.state !== 'failed') {
    return {
      connection: { ...attempt.connection },
      state: 'stale',
      models: previous.models === null ? null : previous.models.map(cloneDetectedModel),
      fetchedAt: previous.fetchedAt,
      validatedAt: observedAt,
      failure: attempt.outcome.kind,
    };
  }
  return {
    connection: { ...attempt.connection },
    state: 'failed',
    models: null,
    fetchedAt: null,
    validatedAt: observedAt,
    failure: attempt.outcome.kind,
  };
}

function reconcileCliCatalogAttemptsAtStoreBoundary(
  input: Readonly<{
    previous: readonly ScopedCliCatalogRuntime[];
    attempts: readonly ScopedCliCatalogAttempt[];
    observedAt: number;
  }>,
): ScopedCliCatalogRuntime[] {
  const observedRoleKeys = new Set(
    input.attempts.map((attempt) => cliCatalogRoleKey(attempt.connection)),
  );
  const observedConnectionKeys = new Set(
    input.attempts.map((attempt) => cliCatalogConnectionKey(attempt.connection)),
  );
  const previousByConnection = new Map<string, ScopedCliCatalogRuntime>();
  const next = new Map<string, ScopedCliCatalogRuntime>();

  for (const runtime of input.previous) {
    const key = cliCatalogConnectionKey(runtime.connection);
    previousByConnection.set(key, runtime);
    if (
      !observedRoleKeys.has(cliCatalogRoleKey(runtime.connection)) ||
      observedConnectionKeys.has(key)
    ) {
      next.set(key, cloneScopedCliCatalogRuntime(runtime));
    }
  }
  for (const attempt of input.attempts) {
    const key = cliCatalogConnectionKey(attempt.connection);
    next.set(
      key,
      runtimeFromCliCatalogAttempt({
        attempt,
        previous: previousByConnection.get(key),
        observedAt: input.observedAt,
      }),
    );
  }
  return [...next.values()].map(cloneScopedCliCatalogRuntime);
}

function findScopedCliCatalogRuntimeAtStoreBoundary(
  runtimes: readonly ScopedCliCatalogRuntime[],
  connection: Pick<ScopedCliCatalogConnection, 'role' | 'tool'>,
): ScopedCliCatalogRuntime | null {
  const roleKey = cliCatalogRoleKey(connection);
  const matches = runtimes.filter((runtime) => cliCatalogRoleKey(runtime.connection) === roleKey);
  return matches.length === 1 && matches[0] !== undefined
    ? cloneScopedCliCatalogRuntime(matches[0])
    : null;
}

function findGenericCliCatalogRuntimeAtStoreBoundary(
  runtimes: readonly ScopedCliCatalogRuntime[],
  tool: CliToolId,
): ScopedCliCatalogRuntime | null {
  const matches = runtimes.filter((runtime) => runtime.connection.tool === tool);
  return matches.length === 1 && matches[0] !== undefined
    ? cloneScopedCliCatalogRuntime(matches[0])
    : null;
}

function reconcileConfiguredProviderOutcomes(input: {
  previous: readonly ConfiguredProviderRuntime[];
  outcomes: readonly ConfiguredProviderOutcome[];
  observedAt: number;
}): ConfiguredProviderRuntime[] {
  const priorByConnection = new Map(
    input.previous.map((entry) => [configuredProviderConnectionKey(entry.connection), entry]),
  );
  const nextByRole = new Map(
    input.previous.map((entry) => [configuredProviderRoleKey(entry.connection), entry]),
  );

  for (const configured of input.outcomes) {
    const previous = priorByConnection.get(configuredProviderConnectionKey(configured.connection));
    if (configured.outcome.kind === 'success') {
      nextByRole.set(configuredProviderRoleKey(configured.connection), {
        connection: { ...configured.connection },
        state: 'fresh',
        catalog: configured.outcome.catalog,
        models: configured.outcome.models.map(cloneDetectedModel),
        fetchedAt: input.observedAt,
        validatedAt: input.observedAt,
      });
      continue;
    }

    if (previous !== undefined && previous.state !== 'failed') {
      nextByRole.set(configuredProviderRoleKey(configured.connection), {
        connection: { ...configured.connection },
        state: 'stale',
        catalog: previous.catalog,
        models: previous.models === null ? null : previous.models.map(cloneDetectedModel),
        fetchedAt: previous.fetchedAt,
        validatedAt: input.observedAt,
        failure: configured.outcome.failure,
        diagnostic: configured.outcome.diagnostic,
      });
      continue;
    }

    nextByRole.set(configuredProviderRoleKey(configured.connection), {
      connection: { ...configured.connection },
      state: 'failed',
      catalog: null,
      models: null,
      fetchedAt: null,
      validatedAt: input.observedAt,
      failure: configured.outcome.failure,
      diagnostic: configured.outcome.diagnostic,
    });
  }

  return [...nextByRole.values()].map(cloneConfiguredProviderRuntime);
}

function configuredProviderFailureKind(error: DetectionSourceError): ProviderCatalogFailureKind {
  switch (error.kind) {
    case 'request-failed':
      return 'request-failed';
    case 'invalid-response':
      return 'malformed';
    case 'missing-credential':
      return 'missing-credential';
    case 'invalid-credential':
      return 'invalid-credential';
    case 'policy-denied':
      return 'policy-denied';
    case 'timeout':
      return 'timeout';
    case 'unsupported':
      return 'endpoint-invalid';
    case 'offline':
      return 'offline';
  }
}

function staleConfiguredProviderRuntimes(input: {
  previous: readonly ConfiguredProviderRuntime[];
  matchingOutcomes?: readonly ConfiguredProviderOutcome[] | undefined;
  // Omitted when the demotion is not a failure — a context change invalidates
  // authority without anything having gone wrong.
  error?: DetectionSourceError | undefined;
  observedAt: number;
}): ConfiguredProviderRuntime[] {
  const matchingConnections =
    input.matchingOutcomes === undefined
      ? null
      : new Set(
          input.matchingOutcomes.map((configured) =>
            configuredProviderConnectionKey(configured.connection),
          ),
        );
  const failure =
    input.error === undefined ? undefined : configuredProviderFailureKind(input.error);

  return input.previous.map((runtime) => {
    const matches =
      matchingConnections === null ||
      matchingConnections.has(configuredProviderConnectionKey(runtime.connection));
    if (!matches || runtime.state === 'failed') return cloneConfiguredProviderRuntime(runtime);

    return {
      connection: { ...runtime.connection },
      state: 'stale',
      catalog: runtime.catalog,
      models: runtime.models === null ? null : runtime.models.map(cloneDetectedModel),
      fetchedAt: runtime.fetchedAt,
      validatedAt: input.observedAt,
      ...(failure === undefined
        ? {}
        : { failure, diagnostic: 'Configured provider catalog refresh did not complete.' }),
    };
  });
}

/**
 * Lanes touch disjoint slices of the projection. Reusing the already-frozen
 * slice a lane did not replace keeps its identity, which is what stops every
 * subscriber re-rendering three times per refresh now that lanes land
 * separately — this codebase has no memoization to fall back on.
 */
function frozenSlice<Value>(
  next: readonly Value[],
  previous: readonly Value[],
  clone: (value: Value) => Value,
): readonly Value[] {
  return next === previous ? previous : deepFreeze(next.map(clone));
}

function freezeModels(models: readonly DetectedModel[]): readonly DetectedModel[] {
  return deepFreeze(models.map(cloneDetectedModel));
}

function freezeConfiguredProviders(
  runtime: readonly ConfiguredProviderRuntime[],
): Readonly<Record<string, ConfiguredProviderRuntime>> {
  const result: Record<string, ConfiguredProviderRuntime> = {};
  for (const entry of runtime) {
    result[configuredProviderRoleKey(entry.connection)] = deepFreeze(
      cloneConfiguredProviderRuntime(entry),
    );
  }
  return deepFreeze(result);
}

function configuredProviderValues(
  providers: Readonly<Record<string, ConfiguredProviderRuntime>>,
): readonly ConfiguredProviderRuntime[] {
  return Object.values(providers);
}

function freezeCliCatalogs(
  runtimes: readonly ScopedCliCatalogRuntime[],
): Readonly<Record<string, ScopedCliCatalogRuntime>> {
  const result: Record<string, ScopedCliCatalogRuntime> = {};
  for (const runtime of runtimes) {
    result[cliCatalogConnectionKey(runtime.connection)] = deepFreeze(
      cloneScopedCliCatalogRuntime(runtime),
    );
  }
  return deepFreeze(result);
}

function cliCatalogValues(
  catalogs: Readonly<Record<string, ScopedCliCatalogRuntime>>,
): readonly ScopedCliCatalogRuntime[] {
  return Object.values(catalogs).map(cloneScopedCliCatalogRuntime);
}

function staleCliCatalogRuntimes(input: {
  previous: readonly ScopedCliCatalogRuntime[];
  observedAt: number;
  failure: ScopedCliCatalogRuntime['failure'];
}): ScopedCliCatalogRuntime[] {
  return input.previous.map((runtime) => {
    if (runtime.state === 'failed') return cloneScopedCliCatalogRuntime(runtime);
    return {
      connection: { ...runtime.connection },
      state: 'stale',
      models: runtime.models === null ? null : runtime.models.map(cloneDetectedModel),
      fetchedAt: runtime.fetchedAt,
      validatedAt: input.observedAt,
      ...(input.failure === undefined ? {} : { failure: input.failure }),
    };
  });
}

function cliCatalogFailure(error: DetectionSourceError): ScopedCliCatalogRuntime['failure'] {
  switch (error.kind) {
    case 'missing-credential':
      return 'missing-credential';
    case 'invalid-credential':
      return 'invalid-credential';
    case 'policy-denied':
      return 'policy-denied';
    case 'timeout':
      return 'timeout';
    case 'unsupported':
      return 'unsupported';
    case 'offline':
      return 'offline';
    case 'invalid-response':
      return 'malformed';
    case 'request-failed':
      return 'offline';
  }
}

function reconciledCliCatalogs(
  input: Readonly<{
    previous: readonly ScopedCliCatalogRuntime[];
    outcome: DetectionSourceOutcome<CliModelSnapshot>;
    observedAt: number;
  }>,
): readonly ScopedCliCatalogRuntime[] {
  switch (input.outcome.kind) {
    case 'fresh':
      return reconcileCliCatalogAttemptsAtStoreBoundary({
        previous: input.previous,
        attempts: input.outcome.snapshot.value,
        observedAt: input.observedAt,
      });
    case 'stale':
      return staleCliCatalogRuntimes({
        previous: input.previous,
        observedAt: input.observedAt,
        failure: cliCatalogFailure(
          input.outcome.snapshot.error ?? {
            kind: 'request-failed',
            message: 'CLI model discovery refresh failed.',
          },
        ),
      });
    case 'failed':
      return staleCliCatalogRuntimes({
        previous: input.previous,
        observedAt: input.observedAt,
        failure: cliCatalogFailure(input.outcome.error),
      });
    case 'not-run':
      return input.previous.map(cloneScopedCliCatalogRuntime);
  }
}

function freezeCatalog(catalog: ModelsDevCatalog): ModelsDevCatalog {
  return deepFreeze(structuredClone(catalog));
}

function cloneError(error: DetectionSourceError): DetectionSourceError {
  return { kind: error.kind, message: error.message };
}

function sourceContextsMatch(
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

function laneContext(lane: DetectionLanePublication): string {
  switch (lane.lane) {
    case 'readiness':
      return sourceContext(lane.outcome);
    case 'modelsDev':
      return modelsDevContext(lane.outcome);
    case 'cliModels':
      return sourceContext(lane.outcome);
  }
}

function laneGeneration(lane: DetectionLanePublication): number | null {
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
function laneIsOutdated(previous: DiscoverySourceRefresh, generation: number | null): boolean {
  return generation !== null && previous.generation !== null && generation < previous.generation;
}

function laneRefreshState(
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

function sourceRefresh<Value extends object>(
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

function modelsDevRefresh(
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

/**
 * A result that predates per-source outcomes still has to answer the per-lane
 * generation guard, so its lanes are stamped with the generation `publish`
 * already resolved for it rather than a zero every real lane would outrank.
 */
function legacyOutcomes(
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

function freshness<Value extends object>(outcome: DetectionSourceOutcome<Value>): Value | null {
  return outcome.kind === 'fresh' || outcome.kind === 'stale' ? outcome.snapshot.value : null;
}

function modelsDevValue(outcome: ModelsDevRefreshOutcome): ModelsDevCatalog | null {
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

function providerModels(
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
function demotedForContextChange(current: ModelCacheState, observedAt: number): ModelCacheState {
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

function laneApplied(
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
      providers: frozenSlice(next.detection.providers, previous.providers, cloneProvider),
      cliTools: frozenSlice(next.detection.cliTools, previous.cliTools, cloneCliTool),
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
  get: store.get,
  subscribe: store.subscribe,
  use: store.use,
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
    if (includes(CLI_TOOL_IDS, provider)) {
      store.set({
        ...current,
        cliModels: { ...current.cliModels, [provider]: cache },
      });
      return;
    }
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
      // lookup; this role-blind map must not serve them.
      if (!current.cliCatalogsLoaded) return current.cliModels[provider]?.models ?? null;
      // A generic tool lookup is deliberately denied when planner/implementer
      // or two selected channels make the catalog ambiguous.
      return (
        findGenericCliCatalogRuntimeAtStoreBoundary(cliCatalogValues(current.cliCatalogs), provider)
          ?.models ?? null
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
      // Mirrors getProviderModels: before a live lane completes the CLI answer
      // comes from the manual-injection map, which is never remembered data.
      if (!current.cliCatalogsLoaded) return false;
      return (
        findGenericCliCatalogRuntimeAtStoreBoundary(cliCatalogValues(current.cliCatalogs), provider)
          ?.state === 'stale'
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
    const match = current.configuredProviders[configuredProviderRoleKey(input)];
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
    const match = findScopedCliCatalogRuntimeAtStoreBoundary(
      cliCatalogValues(current.cliCatalogs),
      input,
    );
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
};
