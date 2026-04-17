import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { modelCacheStore, type DetectedModel } from './model-cache.js';
import type { ModelsDevCatalog } from '../../engine/providers/models-dev.js';

const TTL_MS = 5 * 60 * 1000;
const MODELS_DEV_TTL_MS = 60 * 60 * 1000;

describe('modelCacheStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    modelCacheStore.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const sampleModels: DetectedModel[] = [
    { id: 'qwen2.5:7b', contextLength: 8192, isFree: true },
    { id: 'llama3:8b', contextLength: 4096, isFree: true },
  ];

  describe('setProviderModels / getProviderModels', () => {
    it('sets and retrieves models for a provider', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      const result = modelCacheStore.getProviderModels('ollama');
      expect(result).toEqual(sampleModels);
    });

    it('returns null for uncached provider', () => {
      expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
    });

    it('stores models with fetchedAt timestamp', () => {
      const now = Date.now();
      modelCacheStore.setProviderModels('ollama', sampleModels);
      const cache = modelCacheStore.get().providers['ollama'];
      expect(cache?.fetchedAt).toBe(now);
      expect(cache?.isStale).toBe(false);
    });
  });

  describe('cache expiration', () => {
    it('returns models before TTL expires', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      vi.advanceTimersByTime(TTL_MS - 1);
      expect(modelCacheStore.getProviderModels('ollama')).toEqual(sampleModels);
    });

    it('returns null after TTL expires', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      vi.advanceTimersByTime(TTL_MS);
      expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
    });
  });

  describe('invalidateAll', () => {
    it('marks all providers as stale', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      modelCacheStore.setProviderModels('deepseek', [{ id: 'deepseek-r1' }]);
      modelCacheStore.setProviderModels('lm-studio', [{ id: 'local-model' }]);

      modelCacheStore.invalidateAll();

      expect(modelCacheStore.get().providers['ollama']?.isStale).toBe(true);
      expect(modelCacheStore.get().providers['deepseek']?.isStale).toBe(true);
      expect(modelCacheStore.get().providers['lm-studio']?.isStale).toBe(true);
    });

    it('getProviderModels returns null for all providers after invalidateAll', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      modelCacheStore.setProviderModels('deepseek', [{ id: 'deepseek-r1' }]);

      modelCacheStore.invalidateAll();

      expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
      expect(modelCacheStore.getProviderModels('deepseek')).toBeNull();
    });
  });

  describe('reset', () => {
    it('clears all cached data', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);

      modelCacheStore.reset();

      expect(modelCacheStore.get().providers).toEqual({});
    });
  });

  describe('Models.dev catalog caching', () => {
    const sampleCatalog: ModelsDevCatalog = {
      openai: { id: 'openai', models: { 'gpt-4o': { id: 'gpt-4o' } } },
    };

    describe('setModelsDevCatalog', () => {
      it('stores the catalog', () => {
        modelCacheStore.setModelsDevCatalog(sampleCatalog);
        expect(modelCacheStore.get().modelsDevCatalog).toEqual(sampleCatalog);
      });

      it('sets modelsDevFetchedAt to current time', () => {
        const now = Date.now();
        modelCacheStore.setModelsDevCatalog(sampleCatalog);
        expect(modelCacheStore.get().modelsDevFetchedAt).toBe(now);
      });
    });

    describe('getModelsDevCatalog', () => {
      it('returns catalog when fresh', () => {
        modelCacheStore.setModelsDevCatalog(sampleCatalog);
        expect(modelCacheStore.getModelsDevCatalog()).toEqual(sampleCatalog);
      });

      it('returns null when no catalog is set', () => {
        expect(modelCacheStore.getModelsDevCatalog()).toBeNull();
      });

      it('returns null when stale', () => {
        modelCacheStore.setModelsDevCatalog(sampleCatalog);
        vi.advanceTimersByTime(MODELS_DEV_TTL_MS);
        expect(modelCacheStore.getModelsDevCatalog()).toBeNull();
      });

      it('returns catalog just before TTL expires', () => {
        modelCacheStore.setModelsDevCatalog(sampleCatalog);
        vi.advanceTimersByTime(MODELS_DEV_TTL_MS - 1);
        expect(modelCacheStore.getModelsDevCatalog()).toEqual(sampleCatalog);
      });
    });

    describe('invalidateAll clears Models.dev catalog', () => {
      it('sets modelsDevCatalog to null', () => {
        modelCacheStore.setModelsDevCatalog(sampleCatalog);
        modelCacheStore.invalidateAll();
        expect(modelCacheStore.get().modelsDevCatalog).toBeNull();
      });

      it('sets modelsDevFetchedAt to null', () => {
        modelCacheStore.setModelsDevCatalog(sampleCatalog);
        modelCacheStore.invalidateAll();
        expect(modelCacheStore.get().modelsDevFetchedAt).toBeNull();
      });

      it('also marks all providers stale', () => {
        modelCacheStore.setProviderModels('ollama', sampleModels);
        modelCacheStore.setModelsDevCatalog(sampleCatalog);

        modelCacheStore.invalidateAll();

        expect(modelCacheStore.get().providers['ollama']?.isStale).toBe(true);
        expect(modelCacheStore.getModelsDevCatalog()).toBeNull();
      });
    });

    describe('per-provider caching still works', () => {
      it('provider cache is independent of Models.dev catalog', () => {
        modelCacheStore.setProviderModels('ollama', sampleModels);
        modelCacheStore.setModelsDevCatalog(sampleCatalog);

        expect(modelCacheStore.getProviderModels('ollama')).toEqual(sampleModels);
        expect(modelCacheStore.getModelsDevCatalog()).toEqual(sampleCatalog);
      });

      it('provider TTL expiry does not affect Models.dev catalog', () => {
        modelCacheStore.setProviderModels('ollama', sampleModels);
        modelCacheStore.setModelsDevCatalog(sampleCatalog);

        vi.advanceTimersByTime(TTL_MS);

        expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
        expect(modelCacheStore.getModelsDevCatalog()).toEqual(sampleCatalog);
      });
    });
  });
});
