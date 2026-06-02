import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelCacheStore } from './model-cache.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';

const TTL_MS = 5 * 60 * 1000;
const MODELS_DEV_TTL_MS = 60 * 60 * 1000;

const ollamaModels: DetectedModel[] = [
  { id: 'qwen2.5:7b', contextLength: 8192, isFree: true },
  { id: 'llama3:8b', contextLength: 4096, isFree: true },
];

const deepseekModels: DetectedModel[] = [{ id: 'deepseek-r1' }];

const catalog: ModelsDevCatalog = {
  openai: { id: 'openai', models: { 'gpt-4o': { id: 'gpt-4o' } } },
};

describe('modelCacheStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    modelCacheStore.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('provider cache lifecycle: set → read → TTL expires → invalidate → reset', () => {
    // set + read returns the models with fresh (non-stale) cache metadata
    modelCacheStore.setProviderModels('ollama', ollamaModels);
    expect(modelCacheStore.getProviderModels('ollama')).toEqual(ollamaModels);
    expect(modelCacheStore.get().providers['ollama']?.isStale).toBe(false);

    // just before TTL — still fresh
    vi.advanceTimersByTime(TTL_MS - 1);
    expect(modelCacheStore.getProviderModels('ollama')).toEqual(ollamaModels);

    // at TTL — stale, reads null even though internal state remains populated
    vi.advanceTimersByTime(1);
    expect(modelCacheStore.getProviderModels('ollama')).toBeNull();

    // re-populating refreshes the cache
    modelCacheStore.setProviderModels('ollama', ollamaModels);
    modelCacheStore.setProviderModels('deepseek', deepseekModels);
    expect(modelCacheStore.getProviderModels('ollama')).toEqual(ollamaModels);
    expect(modelCacheStore.getProviderModels('deepseek')).toEqual(deepseekModels);

    // invalidateAll marks every provider stale — subsequent reads are null
    modelCacheStore.invalidateAll();
    expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
    expect(modelCacheStore.getProviderModels('deepseek')).toBeNull();

    // reset clears all cached providers
    modelCacheStore.setProviderModels('ollama', ollamaModels);
    modelCacheStore.reset();
    expect(modelCacheStore.get().providers).toEqual({});
    expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
  });

  it('returns null for an unknown provider before anything is cached', () => {
    expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
  });

  it('Models.dev catalog lifecycle: set → read → TTL expires → invalidate clears it', () => {
    modelCacheStore.setModelsDevCatalog(catalog);
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);

    vi.advanceTimersByTime(MODELS_DEV_TTL_MS - 1);
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);

    vi.advanceTimersByTime(1);
    expect(modelCacheStore.getModelsDevCatalog()).toBeNull();

    modelCacheStore.setModelsDevCatalog(catalog);
    modelCacheStore.invalidateAll();
    expect(modelCacheStore.getModelsDevCatalog()).toBeNull();
  });

  it('returns null for Models.dev catalog before anything is cached', () => {
    expect(modelCacheStore.getModelsDevCatalog()).toBeNull();
  });

  it('provider and Models.dev catalog caches expire independently', () => {
    modelCacheStore.setProviderModels('ollama', ollamaModels);
    modelCacheStore.setModelsDevCatalog(catalog);

    // Provider TTL is shorter than Models.dev TTL — crossing it clears only the provider cache
    vi.advanceTimersByTime(TTL_MS);
    expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);
  });

  it('clones provider models on write and read', () => {
    const models: DetectedModel[] = [{ id: 'mutable', capabilities: ['tools'] }];
    modelCacheStore.setProviderModels('ollama', models);

    models[0]?.capabilities?.push('mutated input');
    expect(modelCacheStore.getProviderModels('ollama')).toEqual([
      { id: 'mutable', capabilities: ['tools'] },
    ]);

    const cached = modelCacheStore.getProviderModels('ollama');
    cached?.[0]?.capabilities?.push('mutated output');

    expect(modelCacheStore.getProviderModels('ollama')).toEqual([
      { id: 'mutable', capabilities: ['tools'] },
    ]);
  });

  it('clones Models.dev catalogs on write and read', () => {
    const mutableCatalog: ModelsDevCatalog = {
      openai: { id: 'openai', models: { 'gpt-4o': { id: 'gpt-4o', limit: { context: 128000 } } } },
    };

    modelCacheStore.setModelsDevCatalog(mutableCatalog);
    mutableCatalog.openai!.models['gpt-4o']!.limit = { context: 1 };

    expect(modelCacheStore.getModelsDevCatalog()?.openai?.models['gpt-4o']?.limit?.context).toBe(
      128000,
    );

    const cached = modelCacheStore.getModelsDevCatalog();
    if (cached) cached.openai!.models['gpt-4o']!.limit = { context: 2 };

    expect(modelCacheStore.getModelsDevCatalog()?.openai?.models['gpt-4o']?.limit?.context).toBe(
      128000,
    );
  });
});
