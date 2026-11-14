import type { DetectionLanePublication } from '../../../engine/detection/lane-channel.js';
import type { ModelsDevRefreshOutcome } from '../../../engine/detection/models-dev-lane.js';
import type { DetectionSourceOutcome } from '../../../engine/detection/types.js';
import type {
  DiscoverySourceRefresh,
  DiscoveryRefreshState,
  DiscoverySourceContexts,
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
