import { mergeCatalogRead } from '../../../core/discovery/catalog-read-merge.js';
import { cloneDetectedModel } from '../../../core/discovery/clone-model.js';
import type { ModelsDevCatalogCacheOutcome } from '../../providers/models-dev/cache.js';
import type { RememberedCliCatalog } from '../cache/schema.js';
import {
  loadRememberedSnapshot,
  saveDetectionCache,
  loadDetectionCacheSnapshot,
  invalidateCache,
} from '../cache/store.js';
import { createDetectionCoordinator } from '../coordinator/create.js';
import { type LaneChannel, createLaneChannel } from '../lane-channel.js';
import { refreshModelsDev, modelsDevCatalogValue } from '../models-dev-lane.js';
import {
  type DetectionCoordinator,
  type DetectionSourceOutcome,
  type CliModelSnapshot,
  type DetectionProjection,
  detectionSourceContextKey,
} from '../types.js';
import {
  sourceContext,
  cloneProjection,
  sourceError,
  cloneCliModels,
  sourceValue,
  EMPTY_PROJECTION,
  EMPTY_CLI_MODELS,
  resultGeneration,
  uninitializedResult,
} from './results.js';
import type {
  DetectionServiceResult,
  DetectionDeps,
  DetectionRefreshOutcomes,
  DetectionLoadInput,
  DetectionRefreshInput,
  DetectionService,
} from './types.js';

const READINESS_TTL_MS = 5 * 60 * 1_000;
// The catalog lane is keyed by tool and executable context, so a snapshot
// inside the window belongs to the same executable that produced it.
const CLI_MODELS_TTL_MS = 5 * 60 * 1_000;

interface PendingLoad {
  readonly promise: Promise<DetectionServiceResult>;
  readonly channel: LaneChannel;
}

export function createDetectionService() {
  let clock: () => number = Date.now;
  const coordinator = createDetectionCoordinator({ now: () => clock() });
  let pendingSave: Promise<void> = Promise.resolve();
  let acceptingSaves = true;
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

  function probedCliCatalogs(
    outcome: DetectionSourceOutcome<CliModelSnapshot>,
  ): RememberedCliCatalog[] {
    if (outcome.kind !== 'fresh' || outcome.origin !== 'request') return [];
    const probedAt = outcome.snapshot.fetchedAt;
    return outcome.snapshot.value.flatMap((attempt) =>
      attempt.outcome.kind === 'success'
        ? [
            {
              tool: attempt.connection.tool,
              models: attempt.outcome.value.map(cloneDetectedModel),
              ...(attempt.namesProject === true ? { namesProject: true } : {}),
              probedAt,
            },
          ]
        : [],
    );
  }

  function rememberedCliCatalogs(
    probed: readonly RememberedCliCatalog[],
    previous: readonly RememberedCliCatalog[],
  ): RememberedCliCatalog[] {
    const probedTools = new Set(probed.map((catalog) => catalog.tool));
    const merged = probed.map((catalog): RememberedCliCatalog => {
      const remembered = previous.find((entry) => entry.tool === catalog.tool);
      const read = mergeCatalogRead({
        cachedModels: remembered?.models,
        missingOnce: remembered?.missingOnce,
        readModels: catalog.models,
      });
      return {
        tool: catalog.tool,
        models: read.models,
        ...(read.missingOnce.length === 0 ? {} : { missingOnce: read.missingOnce }),
        ...(catalog.namesProject === true ? { namesProject: true } : {}),
        probedAt: read.complete ? catalog.probedAt : (remembered?.probedAt ?? 0),
      };
    });
    return [...merged, ...previous.filter((catalog) => !probedTools.has(catalog.tool))];
  }

  function queueSave(
    input: Readonly<{
      projectDir: string | undefined;
      outcome: DetectionSourceOutcome<DetectionProjection>;
      cliModels: DetectionSourceOutcome<CliModelSnapshot>;
    }>,
  ): void {
    if (!acceptingSaves) return;
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
    const probed = probedCliCatalogs(input.cliModels);
    pendingSave = pendingSave.then(async () => {
      const previous = (await loadRememberedSnapshot(projectDir))?.cliCatalogs ?? [];
      const cliCatalogs = rememberedCliCatalogs(probed, previous);
      await saveDetectionCache({
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
      });
    });
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

  function shutdown(): Promise<void> {
    acceptingSaves = false;
    coordinator.shutdown();
    return getPendingSave();
  }

  return { loadDetection, invalidateDetection, refreshDetection, getPendingSave, shutdown };
}

const defaultService = createDetectionService();

export function getDefaultDetectionService(): DetectionService {
  return defaultService;
}
