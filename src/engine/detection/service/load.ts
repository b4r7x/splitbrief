import { loadDetectionCacheSnapshot } from '../cache/store.js';
import type { LaneChannel } from '../lane-channel.js';
import { refreshModelsDev, modelsDevCatalogValue } from '../models-dev-lane.js';
import {
  sourceContext,
  cloneProjection,
  sourceError,
  cloneCliModels,
  sourceValue,
  EMPTY_PROJECTION,
  EMPTY_CLI_MODELS,
  resultGeneration,
} from './results.js';
import { queueSave } from './save.js';
import type {
  DetectionServiceResult,
  DetectionDeps,
  DetectionRefreshOutcomes,
  DetectionServiceState,
} from './types.js';

const READINESS_TTL_MS = 5 * 60 * 1_000;
// The catalog lane is keyed by tool and executable context, so a snapshot
// inside the window belongs to the same executable that produced it.
const CLI_MODELS_TTL_MS = 5 * 60 * 1_000;

export async function loadLanes(
  state: DetectionServiceState,
  input: Readonly<{
    deps: DetectionDeps;
    projectDir: string | undefined;
    mode: 'automatic' | 'manual';
    generation: number;
    channel: LaneChannel;
  }>,
): Promise<DetectionServiceResult> {
  state.clock = input.deps.now ?? Date.now;
  const coordinator = state.coordinator;
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
      cacheOutcomes: state.modelsDevCacheOutcomes,
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
  queueSave(state, { projectDir: input.projectDir, outcome: readiness, cliModels });

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
