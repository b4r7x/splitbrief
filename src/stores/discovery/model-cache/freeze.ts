import type { DetectedModel } from '../../../core/discovery/detection.js';
import { cloneDetectedModel } from '../../../core/discovery/clone-model.js';
import { deepFreeze } from '../../../utils/deep-freeze.js';

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
