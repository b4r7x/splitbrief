import { describe, it, expect, vi } from 'vitest';
import {
  fetchModelsDevCatalog,
  getModelsForProvider,
  type ModelsDevCatalog,
} from './models-dev.js';
import { setupFetchMock } from './testing.js';

const FIXTURE: ModelsDevCatalog = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        cost: { input: 0.000003, output: 0.000015 },
        limit: { context: 200000, output: 8192 },
      },
      'claude-haiku-3': {
        id: 'claude-haiku-3',
        name: 'Claude Haiku 3',
        cost: { input: 0.00000025, output: 0.00000125 },
        limit: { context: 200000, output: 4096 },
      },
    },
  },
  togetherai: {
    id: 'togetherai',
    name: 'Together AI',
    models: {
      'meta-llama/Llama-3-70b': {
        id: 'meta-llama/Llama-3-70b',
        name: 'Llama 3 70B',
        cost: { input: 0.0000009, output: 0.0000009 },
        limit: { context: 8192 },
      },
    },
  },
  lmstudio: {
    id: 'lmstudio',
    name: 'LM Studio',
    models: {
      'qwen2.5-7b': {
        id: 'qwen2.5-7b',
        name: 'Qwen 2.5 7B',
        cost: { input: 0, output: 0 },
        limit: { context: 32768 },
      },
    },
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    models: {
      'llama3.2': {
        id: 'llama3.2',
        name: 'Llama 3.2',
        cost: { input: 0, output: 0 },
        limit: { context: 131072 },
      },
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-4o': {
        id: 'gpt-4o',
        name: 'GPT-4o',
        cost: { input: 0.0000025, output: 0.00001 },
        limit: { context: 128000 },
      },
    },
  },
};

describe('getModelsForProvider', () => {
  it('maps Models.dev models to DetectedModel[]', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    expect(models).toHaveLength(2);
    expect(models.at(0)?.id).toBe('claude-sonnet-4-6');
    expect(models.at(1)?.id).toBe('claude-haiku-3');
  });

  it('converts per-token pricing to per-1M tokens', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.pricingInput).toBe(3);
    expect(sonnet?.pricingOutput).toBe(15);
  });

  it('extracts contextLength from limit.context', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.contextLength).toBe(200000);
  });

  it('maps togetherai provider ID to together', () => {
    const models = getModelsForProvider(FIXTURE, 'together');
    expect(models).toHaveLength(1);
    expect(models.at(0)?.id).toBe('meta-llama/Llama-3-70b');
  });

  it('maps lmstudio provider ID to lm-studio', () => {
    const models = getModelsForProvider(FIXTURE, 'lm-studio');
    expect(models).toHaveLength(1);
    expect(models.at(0)?.id).toBe('qwen2.5-7b');
  });

  it('isFree is true when both costs are 0', () => {
    const models = getModelsForProvider(FIXTURE, 'lm-studio');
    expect(models.at(0)?.isFree).toBe(true);
  });

  it('isFree is false for paid models', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.isFree).toBe(false);
  });

  it('returns empty array for unknown provider', () => {
    const models = getModelsForProvider(FIXTURE, 'groq');
    expect(models).toEqual([]);
  });

  it('returns empty array when catalog is empty', () => {
    const models = getModelsForProvider({}, 'openai');
    expect(models).toEqual([]);
  });

  it('handles model with no cost field gracefully', () => {
    const catalog: ModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: {
          'gpt-no-cost': { id: 'gpt-no-cost' },
        },
      },
    };
    const models = getModelsForProvider(catalog, 'openai');
    expect(models.at(0)?.pricingInput).toBe(0);
    expect(models.at(0)?.pricingOutput).toBe(0);
    expect(models.at(0)?.isFree).toBe(true);
    expect(models.at(0)?.contextLength).toBeUndefined();
  });
});

describe('fetchModelsDevCatalog', () => {
  setupFetchMock();

  it('returns parsed catalog on success', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(FIXTURE), { status: 200 }),
    );

    const result = await fetchModelsDevCatalog();
    expect(result).toEqual(FIXTURE);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://models.dev/api.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('throws on non-ok response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('error', { status: 500 }),
    );

    await expect(fetchModelsDevCatalog()).rejects.toThrow('500');
  });

  it('throws on network error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('network error'));

    await expect(fetchModelsDevCatalog()).rejects.toThrow('network error');
  });
});
