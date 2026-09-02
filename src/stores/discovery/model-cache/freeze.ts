import type { DetectedModel } from '../../../core/discovery/detection.js';
import { cloneDetectedModel } from '../../../core/discovery/clone-model.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/**
 * Lanes touch disjoint slices of the projection. Reusing the already-frozen
 * slice a lane did not replace keeps its identity, which is what stops every
 * subscriber re-rendering three times per refresh now that lanes land
 * separately — this codebase has no memoization to fall back on.
 */
export function frozenSlice<Value>(
  next: readonly Value[],
  previous: readonly Value[],
  clone: (value: Value) => Value,
): readonly Value[] {
  return next === previous ? previous : deepFreeze(next.map(clone));
}

export function freezeModels(models: readonly DetectedModel[]): readonly DetectedModel[] {
  return deepFreeze(models.map(cloneDetectedModel));
}

export function freezeCatalog(catalog: ModelsDevCatalog): ModelsDevCatalog {
  return deepFreeze(structuredClone(catalog));
}
