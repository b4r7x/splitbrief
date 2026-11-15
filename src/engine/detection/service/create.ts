import { createDetectionCoordinator } from '../coordinator/create.js';
import { createLaneChannel } from '../lane-channel.js';
import { loadLanes } from './load.js';
import { sourceContext, uninitializedResult } from './results.js';
import type {
  DetectionServiceResult,
  DetectionDeps,
  DetectionLoadInput,
  DetectionRefreshInput,
  DetectionService,
  DetectionServiceState,
} from './types.js';

function loadKey(input: Readonly<{ deps: DetectionDeps; projectDir: string | undefined }>): string {
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

function loadDetection(
  state: DetectionServiceState,
  input: DetectionLoadInput,
): Promise<DetectionServiceResult> {
  const { deps, projectDir, onLane } = input;
  const key = loadKey({ deps, projectDir });
  const pending = state.pendingLoads.get(key);
  if (pending !== undefined) {
    if (onLane !== undefined) pending.channel.listen(onLane);
    return pending.promise;
  }

  const channel = createLaneChannel();
  if (onLane !== undefined) channel.listen(onLane);
  const generation = state.nextGeneration + 1;
  state.nextGeneration = generation;
  const promise = loadLanes(state, {
    deps,
    projectDir,
    mode: 'automatic',
    generation,
    channel,
  }).finally(() => {
    if (state.pendingLoads.get(key)?.promise === promise) state.pendingLoads.delete(key);
  });
  state.pendingLoads.set(key, { promise, channel });
  return promise;
}

function refreshDetection(
  state: DetectionServiceState,
  input?: DetectionRefreshInput,
): Promise<DetectionServiceResult> {
  if (input === undefined) return Promise.resolve(uninitializedResult(state.nextGeneration));

  const generation = state.nextGeneration + 1;
  state.nextGeneration = generation;
  return loadLanes(state, {
    deps: input.deps,
    projectDir: input.projectDir,
    mode: 'manual',
    generation,
    channel: createLaneChannel(),
  });
}

function shutdown(state: DetectionServiceState): Promise<void> {
  state.acceptingSaves = false;
  state.coordinator.shutdown();
  return state.pendingSave;
}

export function createDetectionService() {
  const state: DetectionServiceState = {
    clock: Date.now,
    coordinator: createDetectionCoordinator({ now: () => state.clock() }),
    pendingSave: Promise.resolve(),
    acceptingSaves: true,
    nextGeneration: 0,
    pendingLoads: new Map(),
    persistedRequestIds: new Set(),
    modelsDevCacheOutcomes: new Map(),
  };
  return {
    loadDetection: (input: DetectionLoadInput) => loadDetection(state, input),
    refreshDetection: (input?: DetectionRefreshInput) => refreshDetection(state, input),
    getPendingSave: () => state.pendingSave,
    shutdown: () => shutdown(state),
  };
}

const defaultService = createDetectionService();

export function getDefaultDetectionService(): DetectionService {
  return defaultService;
}
