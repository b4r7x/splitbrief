import { createStore } from './create-store.js';
import type { ProviderId } from '../core/providers/catalog.js';
import type { DetectedModel } from '../core/types/config.js';
export type { DetectedModel } from '../core/types/config.js';

interface ProviderModelCache {
  models: DetectedModel[];
  fetchedAt: number;
  isStale: boolean;
}

interface ModelCacheState {
  providers: Partial<Record<ProviderId, ProviderModelCache>>;
  isRefreshing: boolean;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes

const initial: ModelCacheState = {
  providers: {},
  isRefreshing: false,
};

const store = createStore<ModelCacheState>(initial);

function isStale(fetchedAt: number): boolean {
  return Date.now() - fetchedAt >= TTL_MS;
}

export const modelCacheStore = {
  ...store,

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

  getProviderModelsStale(provider: ProviderId): DetectedModel[] | null {
    const cache = store.get().providers[provider];
    return cache?.models ?? null;
  },

  isProviderStale(provider: ProviderId): boolean {
    const cache = store.get().providers[provider];
    if (!cache) return true;
    return cache.isStale || isStale(cache.fetchedAt);
  },

  setRefreshing(isRefreshing: boolean): void {
    store.set(prev => ({ ...prev, isRefreshing }));
  },

  invalidateProvider(provider: ProviderId): void {
    store.set(prev => {
      const existing = prev.providers[provider];
      if (!existing) return prev;
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [provider]: { ...existing, isStale: true },
        },
      };
    });
  },

  invalidateAll(): void {
    store.set(prev => ({
      ...prev,
      providers: Object.fromEntries(
        Object.entries(prev.providers).map(([k, v]) => [
          k,
          v ? { ...v, isStale: true } : v,
        ])
      ) as Partial<Record<ProviderId, ProviderModelCache>>,
    }));
  },

  TTL_MS,
};
