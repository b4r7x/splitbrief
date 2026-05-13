import type { ModelCacheAccessor } from '../../../src/engine/providers/model/resolution.js';
import type { ModelsDevCatalog } from '../../../src/core/schemas/models-dev.js';
import type { DetectedModel } from '../../../src/core/types/config-options.js';
import type { ProviderId } from '../../../src/core/schemas/enums.js';

export function makeModelCacheAccessor(overrides?: {
  catalog?: ModelsDevCatalog | null;
  providerModels?: Partial<Record<ProviderId, DetectedModel[]>>;
}): ModelCacheAccessor {
  return {
    getModelsDevCatalog: () => overrides?.catalog ?? null,
    getProviderModels: (providerId) => overrides?.providerModels?.[providerId] ?? null,
  };
}
