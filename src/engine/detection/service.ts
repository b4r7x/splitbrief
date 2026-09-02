import {
  invalidateCache,
  loadDetectionCacheSnapshot,
  saveDetectionCache,
  type RememberedCliCatalog,
} from './cache.js';
import { createDetectionCoordinator } from './coordinator.js';
import {
  type CliModelSnapshot,
  type DetectionCoordinator,
  detectionContextKey,
  detectionSourceContextKey,
  type DetectionProjection,
  type DetectionSourceError,
  type DetectionSourceOutcome,
} from './types.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import {
  cloneCliToolDetection,
  cloneProviderDetection,
} from '../../core/discovery/clone-detection.js';
import { cloneDetectedModel } from '../../core/discovery/clone-model.js';
import { cloneConfiguredProviderOutcome } from './provider-outcomes.js';
import { cloneScopedCliCatalogAttempt } from './cli-catalog-outcomes.js';
import { createLaneChannel, type DetectionLaneListener, type LaneChannel } from './lane-channel.js';
import {
  modelsDevCatalogValue,
  type ModelsDevCatalogFetchResult,
  type ModelsDevCatalogRequest,
  type ModelsDevRefreshOutcome,
  refreshModelsDev,
} from './models-dev-lane.js';
import { assertNever } from '../../utils/type-guards.js';
import type { ModelsDevCatalogCacheOutcome } from '../providers/models-dev-cache.js';
import { createOpaqueIdFactory } from '../../utils/opaque-id.js';

export type { DetectionProjection } from './types.js';

export interface DetectionSourceContexts {
  readonly readiness?: string | undefined;
  readonly modelsDev?: string | undefined;
  readonly cliModels?: string | undefined;
}

export interface ResolvedDetectionSourceContexts {
  readonly readiness: string;
  readonly modelsDev: string;
  readonly cliModels: string;
}

export interface DetectionLaneRequest {
  readonly signal: AbortSignal;
}

export interface CliModelsLaneRequest extends DetectionLaneRequest {
  readonly mode: 'automatic' | 'manual';
}

export interface DetectionDeps {
  detectAll(input: DetectionLaneRequest): Promise<DetectionProjection>;
  fetchModelsDevCatalog(input: ModelsDevCatalogRequest): Promise<ModelsDevCatalogFetchResult>;
  discoverAllCliTools(input: CliModelsLaneRequest): Promise<CliModelSnapshot>;
  readonly offline?: boolean | undefined;
  readonly now?: (() => number) | undefined;
  readonly sourceContexts?: DetectionSourceContexts | undefined;
}

export interface DetectionRefreshOutcomes {
  readonly readiness: DetectionSourceOutcome<DetectionProjection>;
  readonly modelsDev: ModelsDevRefreshOutcome;
  readonly cliModels: DetectionSourceOutcome<CliModelSnapshot>;
}

export interface DetectionServiceResult extends DetectionProjection {
  readonly catalog: ModelsDevCatalog | null;
  readonly cliModels: CliModelSnapshot;
  /** Present for coordinator-backed refreshes; legacy fixture results may omit it. */
  readonly generation?: number | undefined;
  /** Present for coordinator-backed refreshes; legacy fixture results may omit it. */
  readonly outcomes?: DetectionRefreshOutcomes | undefined;
}

export interface DetectionRefreshInput {
  readonly deps: DetectionDeps;
  readonly projectDir?: string | undefined;
}

export interface DetectionLoadInput extends DetectionRefreshInput {
  /**
   * Receives each lane the moment it settles, including any lane that settled
   * before this listener joined a load already in flight. Lane latency spans two
   * orders of magnitude (models.dev tens of milliseconds, native CLI probes
   * seconds), so a caller that publishes progressively must not wait for the
   * awaited whole-result value.
   */
  readonly onLane?: DetectionLaneListener | undefined;
}

export interface DetectionService {
  loadDetection(input: DetectionLoadInput): Promise<DetectionServiceResult>;
  /**
   * A manual refresh must carry dependencies derived from the current runner
   * configuration. The service deliberately retains no prior dependencies.
   */
  refreshDetection(input?: DetectionRefreshInput): Promise<DetectionServiceResult>;
}

const READINESS_TTL_MS = 5 * 60 * 1_000;
// Native catalog results are executable-identity-bound; do not reuse a TTL
// snapshot before the resolver has established the current identity again.
const CLI_MODELS_TTL_MS = 0;
const EMPTY_CLI_MODELS: CliModelSnapshot = [];
const EMPTY_PROJECTION: DetectionProjection = { providers: [], cliTools: [] };
const fallbackDependencyContext = createOpaqueIdFactory('unconfigured-deps');

function cloneProjection(detection: DetectionProjection): DetectionProjection {
  return {
    providers: detection.providers.map(cloneProviderDetection),
    cliTools: detection.cliTools.map(cloneCliToolDetection),
    ...(detection.configuredProviderOutcomes === undefined
      ? {}
      : {
          configuredProviderOutcomes: detection.configuredProviderOutcomes.map(
            cloneConfiguredProviderOutcome,
          ),
        }),
  };
}

function cloneCliModels(cliModels: CliModelSnapshot): CliModelSnapshot {
  return cliModels.map(cloneScopedCliCatalogAttempt);
}

function sourceContext(
  input: Readonly<{
    deps: DetectionDeps;
    projectDir: string | undefined;
    source: keyof DetectionSourceContexts;
  }>,
): string {
  const configured = input.deps.sourceContexts?.[input.source];
  if (configured !== undefined) return configured;
  const dependencyContext = fallbackDependencyContext(input.deps);
  return detectionContextKey({
    platform: process.platform,
    runner: `unconfigured-${input.source}`,
    configGeneration: `${dependencyContext}:${input.projectDir ?? 'process'}`,
  });
}

export function resolveDetectionSourceContexts(
  input: Readonly<{ deps: DetectionDeps; projectDir: string | undefined }>,
): ResolvedDetectionSourceContexts {
  return {
    readiness: sourceContext({
      deps: input.deps,
      projectDir: input.projectDir,
      source: 'readiness',
    }),
    modelsDev: sourceContext({
      deps: input.deps,
      projectDir: input.projectDir,
      source: 'modelsDev',
    }),
    cliModels: sourceContext({
      deps: input.deps,
      projectDir: input.projectDir,
      source: 'cliModels',
    }),
  };
}

function sourceError(source: 'readiness' | 'cli-models'): DetectionSourceError {
  switch (source) {
    case 'readiness':
      return { kind: 'request-failed', message: 'Runner readiness refresh failed.' };
    case 'cli-models':
      return { kind: 'request-failed', message: 'CLI model discovery refresh failed.' };
  }
}

function sourceValue<Value extends object>(
  outcome: DetectionSourceOutcome<Value>,
  fallback: Value,
): Value {
  switch (outcome.kind) {
    case 'fresh':
    case 'stale':
      return outcome.snapshot.value;
    case 'failed':
    case 'not-run':
      return fallback;
  }
}

function resultGeneration(outcomes: DetectionRefreshOutcomes, fallback: number): number {
  const generations = [outcomes.readiness, outcomes.modelsDev, outcomes.cliModels].flatMap(
    (outcome) => {
      switch (outcome.kind) {
        case 'cached':
        case 'fresh':
        case 'not-modified':
        case 'stale':
          return [outcome.snapshot.generation];
        case 'failed':
          return [outcome.generation];
        case 'not-run':
          return [];
        default:
          return assertNever(outcome);
      }
    },
  );
  return generations.reduce((latest, generation) => Math.max(latest, generation), fallback);
}

function uninitializedOutcome<Value extends object>(
  source: 'readiness' | 'models-dev' | 'cli-models',
): DetectionSourceOutcome<Value> {
  return {
    kind: 'not-run',
    source,
    contextKey: 'uninitialized',
    reason: 'uninitialized',
  };
}

function uninitializedResult(generation: number): DetectionServiceResult {
  const outcomes: DetectionRefreshOutcomes = {
    readiness: uninitializedOutcome<DetectionProjection>('readiness'),
    modelsDev: {
      kind: 'not-run',
      source: 'models-dev',
      contextKey: 'uninitialized',
      reason: 'uninitialized',
    },
    cliModels: uninitializedOutcome<CliModelSnapshot>('cli-models'),
  };
  return {
    ...cloneProjection(EMPTY_PROJECTION),
    catalog: null,
    cliModels: cloneCliModels(EMPTY_CLI_MODELS),
    generation,
    outcomes,
  };
}

interface PendingLoad {
  readonly promise: Promise<DetectionServiceResult>;
  readonly channel: LaneChannel;
}

export function createDetectionService() {
  let clock: () => number = Date.now;
  const coordinator = createDetectionCoordinator({ now: () => clock() });
  let pendingSave: Promise<void> = Promise.resolve();
  let nextGeneration = 0;
  const pendingLoads = new Map<string, PendingLoad>();
  const persistedRequestIds = new Set<number>();
  const modelsDevCacheOutcomes = new Map<string, ModelsDevCatalogCacheOutcome>();

  function coordinatorFor(deps: DetectionDeps): DetectionCoordinator {
    clock = deps.now ?? Date.now;
    return coordinator;
  }

  function loadKey(
    input: Readonly<{ deps: DetectionDeps; projectDir: string | undefined }>,
  ): string {
    return [
      input.projectDir ?? 'process',
      sourceContext({ deps: input.deps, projectDir: input.projectDir, source: 'readiness' }),
      sourceContext({ deps: input.deps, projectDir: input.projectDir, source: 'modelsDev' }),
      sourceContext({ deps: input.deps, projectDir: input.projectDir, source: 'cliModels' }),
      input.deps.offline === true ? 'offline' : 'online',
    ]
      .map((part) => encodeURIComponent(part))
      .join('|');
  }

  function rememberedCliCatalogs(
    outcome: DetectionSourceOutcome<CliModelSnapshot>,
  ): RememberedCliCatalog[] {
    if (outcome.kind !== 'fresh') return [];
    const probedAt = outcome.snapshot.fetchedAt;
    return outcome.snapshot.value.flatMap((attempt) =>
      attempt.outcome.kind === 'success'
        ? [
            {
              role: attempt.connection.role,
              tool: attempt.connection.tool,
              models: attempt.outcome.value.map(cloneDetectedModel),
              probedAt,
            },
          ]
        : [],
    );
  }

  function queueSave(
    input: Readonly<{
      projectDir: string | undefined;
      outcome: DetectionSourceOutcome<DetectionProjection>;
      cliModels: DetectionSourceOutcome<CliModelSnapshot>;
    }>,
  ): void {
    const projectDir = input.projectDir;
    if (projectDir === undefined || input.outcome.kind !== 'fresh') return;
    // A TTL-hydrated readiness snapshot still persists when the CLI catalog
    // lane ran a real probe this request — fresh model rows must not be lost.
    const cliModelsProbed =
      input.cliModels.kind === 'fresh' && input.cliModels.origin === 'request';
    if (input.outcome.origin !== 'request' && !cliModelsProbed) return;
    const requestId = input.outcome.snapshot.requestId;
    if (persistedRequestIds.has(requestId)) return;

    persistedRequestIds.add(requestId);
    const snapshot = input.outcome.snapshot;
    const projection = cloneProjection(snapshot.value);
    const cliCatalogs = rememberedCliCatalogs(input.cliModels);
    pendingSave = pendingSave.then(() =>
      saveDetectionCache({
        projectDir,
        snapshot: {
          contextKey: snapshot.contextKey,
          fetchedAt: snapshot.fetchedAt,
          validatedAt: snapshot.validatedAt,
          generation: snapshot.generation,
          requestId: snapshot.requestId,
          // Disk cache stays the sanitized presentation projection. Role scoped
          // provider outcomes remain memory-only because they carry catalog
          // membership and connection-scoped diagnostics; remembered model rows
          // are re-sanitized to the cached subset inside saveDetectionCache.
          providers: projection.providers,
          cliTools: projection.cliTools,
          ...(cliCatalogs.length === 0 ? {} : { cliCatalogs }),
        },
      }),
    );
  }

  async function load(
    input: Readonly<{
      deps: DetectionDeps;
      projectDir: string | undefined;
      mode: 'automatic' | 'manual';
      generation: number;
      channel: LaneChannel;
    }>,
  ): Promise<DetectionServiceResult> {
    const coordinator = coordinatorFor(input.deps);
    const readinessContext = sourceContext({
      deps: input.deps,
      projectDir: input.projectDir,
      source: 'readiness',
    });
    const modelsDevContext = sourceContext({
      deps: input.deps,
      projectDir: input.projectDir,
      source: 'modelsDev',
    });
    const cliModelsContext = sourceContext({
      deps: input.deps,
      projectDir: input.projectDir,
      source: 'cliModels',
    });
    if (input.mode === 'automatic' && input.projectDir !== undefined) {
      const existing = coordinator.snapshot({ source: 'readiness', contextKey: readinessContext });
      const cached =
        existing === undefined
          ? await loadDetectionCacheSnapshot({
              projectDir: input.projectDir,
              contextKey: readinessContext,
            })
          : null;
      if (cached !== null) {
        coordinator.hydrate({
          source: 'readiness',
          contextKey: readinessContext,
          value: cloneProjection(cached),
          fetchedAt: cached.fetchedAt,
          validatedAt: cached.validatedAt,
          generation: cached.generation,
          requestId: cached.requestId,
          stale: true,
        });
      }
    }

    // Each lane announces itself the moment it settles; the whole result is
    // still awaited below so persistence keeps pairing readiness with the CLI
    // lane.
    const [readiness, modelsDev, cliModels] = await Promise.all([
      coordinator
        .refresh({
          source: 'readiness',
          contextKey: readinessContext,
          ttlMs: READINESS_TTL_MS,
          mode: input.mode,
          offline: input.deps.offline,
          load: async (signal) => cloneProjection(await input.deps.detectAll({ signal })),
          error: () => sourceError('readiness'),
        })
        .then((outcome) => {
          input.channel.announce({ lane: 'readiness', outcome });
          return outcome;
        }),
      refreshModelsDev({
        contextKey: modelsDevContext,
        deps: input.deps,
        mode: input.mode,
        coordinator,
        cacheOutcomes: modelsDevCacheOutcomes,
        now: () => clock(),
      }).then((outcome) => {
        input.channel.announce({ lane: 'modelsDev', outcome });
        return outcome;
      }),
      coordinator
        .refresh({
          source: 'cli-models',
          contextKey: cliModelsContext,
          ttlMs: CLI_MODELS_TTL_MS,
          mode: input.mode,
          offline: input.deps.offline,
          load: async (signal) =>
            cloneCliModels(await input.deps.discoverAllCliTools({ signal, mode: input.mode })),
          error: () => sourceError('cli-models'),
        })
        .then((outcome) => {
          input.channel.announce({ lane: 'cliModels', outcome });
          return outcome;
        }),
    ]);
    const outcomes: DetectionRefreshOutcomes = { readiness, modelsDev, cliModels };
    queueSave({ projectDir: input.projectDir, outcome: readiness, cliModels });

    const detection = cloneProjection(sourceValue(readiness, EMPTY_PROJECTION));
    const cliModelsValue = cloneCliModels(sourceValue(cliModels, EMPTY_CLI_MODELS));
    return {
      providers: detection.providers,
      cliTools: detection.cliTools,
      catalog: modelsDevCatalogValue(modelsDev),
      cliModels: cliModelsValue,
      generation: resultGeneration(outcomes, input.generation),
      outcomes,
    };
  }

  function loadDetection(input: DetectionLoadInput): Promise<DetectionServiceResult> {
    const { deps, projectDir, onLane } = input;
    const key = loadKey({ deps, projectDir });
    const pending = pendingLoads.get(key);
    if (pending !== undefined) {
      if (onLane !== undefined) pending.channel.listen(onLane);
      return pending.promise;
    }

    const channel = createLaneChannel();
    if (onLane !== undefined) channel.listen(onLane);
    const generation = nextGeneration + 1;
    nextGeneration = generation;
    const promise = load({
      deps,
      projectDir,
      mode: 'automatic',
      generation,
      channel,
    }).finally(() => {
      if (pendingLoads.get(key)?.promise === promise) pendingLoads.delete(key);
    });
    pendingLoads.set(key, { promise, channel });
    return promise;
  }

  async function invalidateDetection(input: DetectionRefreshInput): Promise<void> {
    const projectDir = input.projectDir;
    if (projectDir !== undefined) await invalidateCache(projectDir);

    const coordinator = coordinatorFor(input.deps);
    coordinator.invalidate({
      source: 'readiness',
      contextKey: sourceContext({ deps: input.deps, projectDir, source: 'readiness' }),
    });
    coordinator.invalidate({
      source: 'models-dev',
      contextKey: sourceContext({ deps: input.deps, projectDir, source: 'modelsDev' }),
    });
    modelsDevCacheOutcomes.delete(
      detectionSourceContextKey({
        source: 'models-dev',
        contextKey: sourceContext({ deps: input.deps, projectDir, source: 'modelsDev' }),
      }),
    );
    coordinator.invalidate({
      source: 'cli-models',
      contextKey: sourceContext({ deps: input.deps, projectDir, source: 'cliModels' }),
    });
  }

  function refreshDetection(input?: DetectionRefreshInput): Promise<DetectionServiceResult> {
    if (input === undefined) return Promise.resolve(uninitializedResult(nextGeneration));

    const generation = nextGeneration + 1;
    nextGeneration = generation;
    return load({
      deps: input.deps,
      projectDir: input.projectDir,
      mode: 'manual',
      generation,
      channel: createLaneChannel(),
    });
  }

  function getPendingSave(): Promise<void> {
    return pendingSave;
  }

  return { loadDetection, invalidateDetection, refreshDetection, getPendingSave };
}

const defaultService = createDetectionService();

export function getDefaultDetectionService(): DetectionService {
  return defaultService;
}
