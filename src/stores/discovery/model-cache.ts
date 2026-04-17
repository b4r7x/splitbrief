import { createStore, storeBase } from '../create-store.js';
import { isProviderId, type ProviderId } from '../../core/types/schemas/enums.js';
import type { DetectedModel } from '../../core/types/config-options.js';
import type { ModelsDevCatalog } from '../../core/types/model-catalog.js';
export type { DetectedModel } from '../../core/types/config-options.js';

interface ProviderModelCache {
  models: DetectedModel[];
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

function isStale(fetchedAt: number): boolean {
  return Date.now() - fetchedAt >= TTL_MS;
}

export const modelCacheStore = {
  ...storeBase(store),

  setProviderModels(provider: ProviderId, models: DetectedModel[]): void {
    store.set(prev => ({
      ...prev,
      providers: {
        ...prev.providers,
        [provider]: { models, fetchedAt: Date.now(), isStale: false },
      },
    }));
  },

  getProviderModels(provider: ProviderId): DetectedModel[] | null {
    const cache = store.get().providers[provider];
    if (!cache || cache.isStale) return null;
    if (isStale(cache.fetchedAt)) return null;
    return cache.models;
  },

  // Object.entries is safe here: runs inside store.set(), not inside useStores() Proxy tracking.
  invalidateAll(): void {
    store.set(prev => {
      const providers: Partial<Record<ProviderId, ProviderModelCache>> = {};
      for (const [k, v] of Object.entries(prev.providers)) {
        if (!isProviderId(k)) continue;
        if (v) providers[k] = { ...v, isStale: true };
      }
      return { ...prev, providers, modelsDevCatalog: null, modelsDevFetchedAt: null };
    });
  },

  setModelsDevCatalog(catalog: ModelsDevCatalog): void {
    store.set(prev => ({ ...prev, modelsDevCatalog: catalog, modelsDevFetchedAt: Date.now() }));
  },

  getModelsDevCatalog(): ModelsDevCatalog | null {
    const { modelsDevCatalog, modelsDevFetchedAt } = store.get();
    if (!modelsDevCatalog || modelsDevFetchedAt === null) return null;
    if (Date.now() - modelsDevFetchedAt >= MODELS_DEV_TTL_MS) return null;
    return modelsDevCatalog;
  },
};
