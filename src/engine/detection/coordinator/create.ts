import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import type {
  CliModelSnapshot,
  CliModelsSourceRequest,
  CreateDetectionCoordinatorOptions,
  DetectionCoordinator,
  DetectionProjection,
  DetectionSourceHydration,
  DetectionSourceId,
  DetectionSourceOutcome,
  DetectionSourceRequest,
  DetectionSourceSnapshot,
  ModelsDevSourceRequest,
  ReadinessSourceRequest,
} from '../types.js';
import { refreshSource, stopRefreshes } from './refresh.js';
import { hydrateSnapshot, invalidateSnapshot, readSnapshot } from './stored.js';
import type { DetectionCoordinatorState } from './types.js';

export function createDetectionCoordinator(
  options: CreateDetectionCoordinatorOptions = {},
): DetectionCoordinator {
  const state: DetectionCoordinatorState = {
    now: options.now ?? Date.now,
    snapshots: new Map(),
    activeContexts: new Map(),
    pendingByScope: new Map(),
    activeBySource: new Map(),
    nextGeneration: 0,
    nextRequestId: 0,
    stopped: false,
  };

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
    return refreshSource(state, input);
  }

  function snapshot(
    input: Readonly<{ source: 'readiness'; contextKey: string }>,
  ): DetectionSourceSnapshot<DetectionProjection> | undefined;
  function snapshot(
    input: Readonly<{ source: 'models-dev'; contextKey: string }>,
  ): DetectionSourceSnapshot<ModelsDevCatalog> | undefined;
  function snapshot(
    input: Readonly<{ source: 'cli-models'; contextKey: string }>,
  ): DetectionSourceSnapshot<CliModelSnapshot> | undefined;
  function snapshot(
    input: Readonly<{ source: DetectionSourceId; contextKey: string }>,
  ): DetectionSourceSnapshot<object> | undefined {
    return readSnapshot(state, input);
  }

  return {
    refresh,
    snapshot,
    shutdown: () => stopRefreshes(state),
    invalidate: (input) => invalidateSnapshot(state, input),
    hydrate: (input: DetectionSourceHydration) => hydrateSnapshot(state, input),
  };
}
