import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { modelCacheStore, type DetectedModel } from './model-cache.js';

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
      vi.advanceTimersByTime(modelCacheStore.TTL_MS - 1);
      expect(modelCacheStore.getProviderModels('ollama')).toEqual(sampleModels);
    });

    it('returns null after TTL expires', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      vi.advanceTimersByTime(modelCacheStore.TTL_MS);
      expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
    });

    it('isProviderStale returns true after TTL expires', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      expect(modelCacheStore.isProviderStale('ollama')).toBe(false);
      vi.advanceTimersByTime(modelCacheStore.TTL_MS);
      expect(modelCacheStore.isProviderStale('ollama')).toBe(true);
    });
  });

  describe('invalidateProvider', () => {
    it('marks a single provider as stale', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      modelCacheStore.setProviderModels('deepseek', [{ id: 'deepseek-r1' }]);

      modelCacheStore.invalidateProvider('ollama');

      expect(modelCacheStore.get().providers['ollama']?.isStale).toBe(true);
      expect(modelCacheStore.get().providers['deepseek']?.isStale).toBe(false);
    });

    it('getProviderModels returns null after invalidation', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      modelCacheStore.invalidateProvider('ollama');
      expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
    });

    it('does nothing for uncached provider', () => {
      modelCacheStore.invalidateProvider('ollama');
      expect(modelCacheStore.get().providers['ollama']).toBeUndefined();
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

  describe('getProviderModelsStale', () => {
    it('returns models even after TTL expires', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      vi.advanceTimersByTime(modelCacheStore.TTL_MS + 1000);

      // getProviderModels returns null (stale)
      expect(modelCacheStore.getProviderModels('ollama')).toBeNull();

      // getProviderModelsStale still returns the models
      expect(modelCacheStore.getProviderModelsStale('ollama')).toEqual(sampleModels);
    });

    it('returns models after invalidateProvider', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      modelCacheStore.invalidateProvider('ollama');
      expect(modelCacheStore.getProviderModelsStale('ollama')).toEqual(sampleModels);
    });

    it('returns null for uncached provider', () => {
      expect(modelCacheStore.getProviderModelsStale('ollama')).toBeNull();
    });
  });

  describe('isProviderStale', () => {
    it('returns true for uncached provider', () => {
      expect(modelCacheStore.isProviderStale('ollama')).toBe(true);
    });

    it('returns false for freshly cached provider', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      expect(modelCacheStore.isProviderStale('ollama')).toBe(false);
    });

    it('returns true after invalidateProvider', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      modelCacheStore.invalidateProvider('ollama');
      expect(modelCacheStore.isProviderStale('ollama')).toBe(true);
    });

    it('returns true after TTL expires', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      vi.advanceTimersByTime(modelCacheStore.TTL_MS);
      expect(modelCacheStore.isProviderStale('ollama')).toBe(true);
    });
  });

  describe('setRefreshing', () => {
    it('sets isRefreshing to true', () => {
      expect(modelCacheStore.get().isRefreshing).toBe(false);
      modelCacheStore.setRefreshing(true);
      expect(modelCacheStore.get().isRefreshing).toBe(true);
    });

    it('sets isRefreshing to false', () => {
      modelCacheStore.setRefreshing(true);
      modelCacheStore.setRefreshing(false);
      expect(modelCacheStore.get().isRefreshing).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears all cached data', () => {
      modelCacheStore.setProviderModels('ollama', sampleModels);
      modelCacheStore.setRefreshing(true);

      modelCacheStore.reset();

      expect(modelCacheStore.get().providers).toEqual({});
      expect(modelCacheStore.get().isRefreshing).toBe(false);
    });
  });
});
