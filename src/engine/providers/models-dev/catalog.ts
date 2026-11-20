import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import type { CatalogVendorId } from '../../../core/providers/known-models.js';
import type { ProviderId } from '../../../core/schemas/enums.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import type { ModelVendorIdentity } from '../model/parsing.js';
import { modelToDetected, mergeDetectedModel } from './detected-model.js';
import {
  type ModelsDevCatalogCacheOptions,
  type ModelsDevCatalogCacheOutcome,
  refreshModelsDevCatalogCache,
  modelsDevCatalogFailureError,
} from './cache.js';

/** A models.dev vendor: the runner id itself, or the lab a runner fronts. */
export type ModelsDevProviderId = ProviderId | CatalogVendorId;

/**
 * The map exists for an api provider whose models.dev vendor key differs from its runner id;
 * CLI runner ids never read models.dev (REQ-B08, enforced in src/engine/providers/model/resolution.ts).
 */
const PROVIDER_TO_MODELS_DEV_IDS: Partial<Record<ModelsDevProviderId, string[]>> = {
  'lm-studio': ['lmstudio'],
};

function toModelsDevProviderIds(providerId: ModelsDevProviderId): string[] {
  return PROVIDER_TO_MODELS_DEV_IDS[providerId] ?? [providerId];
}

export async function fetchModelsDevCatalogWithCache(
  options: ModelsDevCatalogCacheOptions = {},
): Promise<ModelsDevCatalogCacheOutcome> {
  return refreshModelsDevCatalogCache(options);
}

export async function fetchModelsDevCatalog(
  options: ModelsDevCatalogCacheOptions = {},
): Promise<ModelsDevCatalog> {
  const outcome = await fetchModelsDevCatalogWithCache(options);
  switch (outcome.kind) {
    case 'cached':
    case 'fresh':
    case 'not-modified':
    case 'stale':
      return outcome.snapshot.catalog;
    case 'failed':
      throw modelsDevCatalogFailureError(outcome.failure);
  }
}

/**
 * Model-keyed catalog lookup for a runner that has no catalog vendor of its own
 * — a custom endpoint. A `vendor/model` prefix narrows the search to that
 * vendor; a bare id searches every vendor in catalog order.
 */
export function findCatalogModelByIdentity(
  catalog: ModelsDevCatalog,
  identity: ModelVendorIdentity,
): DetectedModel | null {
  for (const [key, provider] of Object.entries(catalog)) {
    if (identity.vendor !== undefined && key !== identity.vendor && provider.id !== identity.vendor)
      continue;
    for (const model of Object.values(provider.models)) {
      if (model.id !== identity.bareId) continue;
      return modelToDetected(provider.id, model);
    }
  }
  return null;
}

export function getModelsForProvider(
  catalog: ModelsDevCatalog,
  providerId: ModelsDevProviderId,
): DetectedModel[] {
  const merged = new Map<string, DetectedModel>();

  for (const modelsDevId of toModelsDevProviderIds(providerId)) {
    const provider = catalog[modelsDevId];
    if (!provider?.models) continue;

    for (const model of Object.values(provider.models)) {
      const detected = modelToDetected(provider.id, model);
      const identity = `${provider.id}\u0000${model.id}`;
      merged.set(identity, mergeDetectedModel(merged.get(identity), detected));
    }
  }

  return [...merged.values()];
}
