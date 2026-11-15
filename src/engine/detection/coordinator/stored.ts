import {
  detectionSourceContextKey,
  type DetectionSourceHydration,
  type DetectionSourceId,
  type DetectionSourceSnapshot,
} from '../types.js';
import { supersede } from './refresh.js';
import { cloneError, cloneSnapshot, copySourceValue } from './snapshots.js';
import type { DetectionCoordinatorState } from './types.js';

export function readSnapshot(
  state: DetectionCoordinatorState,
  input: Readonly<{ source: DetectionSourceId; contextKey: string }>,
): DetectionSourceSnapshot<object> | undefined {
  const found = state.snapshots.get(detectionSourceContextKey(input));
  return found === undefined ? undefined : cloneSnapshot(found);
}

export function hydrateSnapshot(
  state: DetectionCoordinatorState,
  input: DetectionSourceHydration,
): void {
  const active = state.activeBySource.get(input.source);
  if (active !== undefined && active.contextKey !== input.contextKey) supersede(state, active);
  state.activeContexts.set(input.source, input.contextKey);

  const generation = input.generation ?? state.nextGeneration + 1;
  const requestId = input.requestId ?? state.nextRequestId + 1;
  state.nextGeneration = Math.max(state.nextGeneration, generation);
  state.nextRequestId = Math.max(state.nextRequestId, requestId);
  const snapshot: DetectionSourceSnapshot<object> = {
    source: input.source,
    contextKey: input.contextKey,
    generation,
    requestId,
    fetchedAt: input.fetchedAt,
    validatedAt: input.validatedAt,
    stale: input.stale ?? false,
    value: copySourceValue(input.source, input.value),
    ...(input.error === undefined ? {} : { error: cloneError(input.error) }),
  };
  state.snapshots.set(detectionSourceContextKey(input), snapshot);
}

export function invalidateSnapshot(
  state: DetectionCoordinatorState,
  input: Readonly<{ source: DetectionSourceId; contextKey: string }>,
): void {
  const active = state.activeBySource.get(input.source);
  if (active !== undefined && active.contextKey === input.contextKey) supersede(state, active);
  state.snapshots.delete(detectionSourceContextKey(input));
}
