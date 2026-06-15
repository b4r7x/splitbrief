import { createStore, storeBase } from '../create-store.js';
import { isProviderId, type ProviderId } from '../../core/schemas/enums.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import { cloneDetectedModel } from '../../core/discovery/clone-model.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';

interface ProviderModelCache {
  models: readonly DetectedModel[];
  fetchedAt: number;
  isStale: boolean;
}

interface ModelCacheState {
  providers: Partial<Record<ProviderId, ProviderModelCache>>;
  modelsDevCatalog: ModelsDevCatalog | null;
  modelsDevFetchedAt: number | null;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const MODELS_DEV_TTL_MS = 60 * 60 * 1000; // 1 hour

const initial: ModelCacheState = {
  providers: {},
  modelsDevCatalog: null,
  modelsDevFetchedAt: null,
};

const store = createStore<ModelCacheState>(initial);

function isExpired(fetchedAt: number): boolean {
  return Date.now() - fetchedAt >= TTL_MS;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function freezeModels(models: DetectedModel[]): readonly DetectedModel[] {
  return deepFreeze(models.map(cloneDetectedModel));
}

function freezeCatalog(catalog: ModelsDevCatalog): ModelsDevCatalog {
  return deepFreeze(structuredClone(catalog));
}

export const modelCacheStore = {
  ...storeBase(store),

  setProviderModels(provider: ProviderId, models: DetectedModel[]): void {
    const frozen = freezeModels(models);
    store.set((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [provider]: { models: frozen, fetchedAt: Date.now(), isStale: false },
      },
    }));
  },

  getProviderModels(provider: ProviderId): readonly DetectedModel[] | null {
    const cache = store.get().providers[provider];
    if (!cache || cache.isStale) return null;
    if (isExpired(cache.fetchedAt)) return null;
    return cache.models;
  },

  // Object.entries is safe here: runs inside store.set(), not inside useStores() Proxy tracking.
  invalidateAll(): void {
    store.set((prev) => {
      const providers: Partial<Record<ProviderId, ProviderModelCache>> = {};
      for (const [k, v] of Object.entries(prev.providers)) {
        if (!isProviderId(k)) continue;
        if (v) providers[k] = { ...v, isStale: true };
      }
      return { ...prev, providers, modelsDevCatalog: null, modelsDevFetchedAt: null };
    });
  },

  setModelsDevCatalog(catalog: ModelsDevCatalog): void {
    store.set((prev) => ({
      ...prev,
      modelsDevCatalog: freezeCatalog(catalog),
      modelsDevFetchedAt: Date.now(),
    }));
  },

  getModelsDevCatalog(): ModelsDevCatalog | null {
    const { modelsDevCatalog, modelsDevFetchedAt } = store.get();
    if (!modelsDevCatalog || modelsDevFetchedAt === null) return null;
    if (Date.now() - modelsDevFetchedAt >= MODELS_DEV_TTL_MS) return null;
    return modelsDevCatalog;
  },
};
