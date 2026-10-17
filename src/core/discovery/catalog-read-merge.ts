import { cloneDetectedModel } from './clone-model.js';
import type { DetectedModel } from './detection.js';

export const MAX_CLI_CATALOG_READ_MODELS = 1_000;

export function mergeCatalogRead(input: {
  cachedModels: readonly DetectedModel[] | null | undefined;
  missingOnce: readonly string[] | undefined;
  readModels: readonly DetectedModel[];
}): { models: DetectedModel[]; missingOnce: string[]; complete: boolean } {
  const readIds = new Set(input.readModels.map((model) => model.id));
  const previouslyMissing = new Set(input.missingOnce);
  const models = input.readModels.map(cloneDetectedModel);
  const missingOnce: string[] = [];
  for (const model of input.cachedModels ?? []) {
    if (readIds.has(model.id) || previouslyMissing.has(model.id)) continue;
    models.push(cloneDetectedModel(model));
    missingOnce.push(model.id);
  }
  return {
    models,
    missingOnce,
    complete: input.readModels.length > 0 && missingOnce.length === 0,
  };
}

/**
 * A tool's model catalog as the last read left it: the rows it serves (`null` when no read
 * succeeded) and the ids the last successful read dropped (`missingOnce`).
 */
export type SavedCatalog = Readonly<{
  models: readonly Readonly<{ id: string }>[] | null;
  missingOnce?: readonly string[] | undefined;
}>;
