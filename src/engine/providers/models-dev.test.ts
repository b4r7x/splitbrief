import { describe, it, expect, vi } from 'vitest';
import { fetchModelsDevCatalog, getModelsForProvider } from './models-dev.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

const FIXTURE: ModelsDevCatalog = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 200000, output: 8192 },
        temperature: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
      'claude-haiku-3': {
        id: 'claude-haiku-3',
        name: 'Claude Haiku 3',
        cost: { input: 0.25, output: 1.25 },
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
        cost: { input: 0.9, output: 0.9 },
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
        cost: { input: 2.5, output: 10 },
        limit: { context: 128000 },
      },
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        cost: {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          tiers: [
            {
              input: 5,
              output: 22.5,
              cache_read: 0.5,
              tier: { type: 'context', size: 272000 },
            },
          ],
        },
        limit: { context: 400000 },
      },
    },
  },
  'github-copilot': {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    models: {
      'claude-opus-4.6': {
        id: 'claude-opus-4.6',
        name: 'Claude Opus 4.6',
        limit: { context: 1_000_000 },
      },
    },
  },
  kilo: {
    id: 'kilo',
    name: 'Kilo Code',
    models: {
      'kimi-k2.5': {
        id: 'kimi-k2.5',
        name: 'Kimi K2.5',
        limit: { context: 256000 },
      },
    },
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        limit: { context: 1_000_000 },
      },
    },
  },
  'opencode-go': {
    id: 'opencode-go',
    name: 'OpenCode Go',
    models: {
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        limit: { context: 400000 },
      },
    },
  },
};

describe('getModelsForProvider', () => {
  it('maps Models.dev models to DetectedModel[] with paid and sparse pricing fields', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    expect(models).toHaveLength(2);
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    const haiku = models.find((m) => m.id === 'claude-haiku-3');
    expect(sonnet).toMatchObject({
      id: 'claude-sonnet-4-6',
      pricingInput: 3,
      pricingOutput: 15,
      pricingCacheRead: 0.3,
      pricingCacheWrite: 3.75,
      contextLength: 200000,
      maxOutputTokens: 8192,
      supportsTemperature: true,
      supportsReasoning: true,
      supportsImages: true,
      isFree: false,
    });
    expect(haiku).toMatchObject({
      id: 'claude-haiku-3',
      isFree: false,
    });
  });

  it('preserves models.dev context pricing tiers', () => {
    const models = getModelsForProvider(FIXTURE, 'openai');
    const gpt = models.find((m) => m.id === 'gpt-5.4');
    expect(gpt?.pricingTiers).toEqual([
      {
        type: 'context',
        thresholdTokens: 272000,
        inputPer1M: 5,
        outputPer1M: 22.5,
        cacheReadPer1M: 0.5,
      },
    ]);
  });

  it('normalizes legacy context_over_200k when no equivalent explicit tier exists', () => {
    const catalog: ModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: {
          legacy: {
            id: 'legacy',
            cost: {
              input: 1,
              output: 2,
              context_over_200k: { input: 3, output: 4, cache_read: 0.3 },
            },
          },
        },
      },
    };
    const models = getModelsForProvider(catalog, 'openai');
    expect(models.at(0)?.pricingTiers).toEqual([
      {
        type: 'context',
        thresholdTokens: 200000,
        inputPer1M: 3,
        outputPer1M: 4,
        cacheReadPer1M: 0.3,
      },
    ]);
  });

  it('ignores unsupported pricing tier shapes', () => {
    const catalog: ModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: {
          odd: {
            id: 'odd',
            cost: {
              input: 1,
              output: 2,
              tiers: [{ input: 9, tier: { type: 'time', size: 'large' } }],
            },
          },
        },
      },
    };
    const models = getModelsForProvider(catalog, 'openai');
    expect(models.at(0)?.pricingTiers).toBeUndefined();
  });

  it.each([
    { providerId: 'together', modelId: 'meta-llama/Llama-3-70b' },
    { providerId: 'lm-studio', modelId: 'qwen2.5-7b' },
    { providerId: 'copilot', modelId: 'claude-opus-4.6' },
    { providerId: 'kilo-code', modelId: 'kimi-k2.5' },
  ] as const)('maps models.dev catalog aliases to $providerId', ({ providerId, modelId }) => {
    const models = getModelsForProvider(FIXTURE, providerId);
    expect(models).toHaveLength(1);
    expect(models.at(0)?.id).toBe(modelId);
  });

  it('leaves maxOutputTokens undefined when limit.output is absent', () => {
    const models = getModelsForProvider(FIXTURE, 'together');
    expect(models.at(0)?.maxOutputTokens).toBeUndefined();
  });

  it('merges opencode and opencode-go provider IDs for opencode', () => {
    const models = getModelsForProvider(FIXTURE, 'opencode');
    expect(models).toHaveLength(2);
    expect(models.map((model) => model.id)).toEqual(
      expect.arrayContaining(['claude-sonnet-4-6', 'gpt-5.4']),
    );
  });

  it('marks zero-cost local models as free', () => {
    const models = getModelsForProvider(FIXTURE, 'lm-studio');
    expect(models.at(0)).toMatchObject({ id: 'qwen2.5-7b', isFree: true });
  });

  it('returns empty array for unknown provider', () => {
    const models = getModelsForProvider(FIXTURE, 'groq');
    expect(models).toEqual([]);
  });

  it('returns empty array when catalog is empty', () => {
    const models = getModelsForProvider({}, 'openai');
    expect(models).toEqual([]);
  });

  it('returns models with undefined pricing fields when the catalog omits cost', () => {
    const catalog: ModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: {
          'gpt-no-cost': { id: 'gpt-no-cost' },
        },
      },
    };
    const models = getModelsForProvider(catalog, 'openai');
    expect(models.at(0)?.pricingInput).toBeUndefined();
    expect(models.at(0)?.pricingOutput).toBeUndefined();
    expect(models.at(0)?.isFree).toBeUndefined();
    expect(models.at(0)?.contextLength).toBeUndefined();
  });

  it('computes releaseDate as max of release_date and last_updated', () => {
    const catalog: ModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: {
          'gpt-old': { id: 'gpt-old', release_date: '2024-06-01', last_updated: '2025-03-15' },
          'gpt-new': { id: 'gpt-new', release_date: '2025-11-18', last_updated: '2025-01-01' },
          'gpt-release-only': { id: 'gpt-release-only', release_date: '2025-05-01' },
          'gpt-update-only': { id: 'gpt-update-only', last_updated: '2025-08-01' },
          'gpt-no-dates': { id: 'gpt-no-dates' },
        },
      },
    };
    const models = getModelsForProvider(catalog, 'openai');
    expect(models.find((m) => m.id === 'gpt-old')?.releaseDate).toBe('2025-03-15');
    expect(models.find((m) => m.id === 'gpt-new')?.releaseDate).toBe('2025-11-18');
    expect(models.find((m) => m.id === 'gpt-release-only')?.releaseDate).toBe('2025-05-01');
    expect(models.find((m) => m.id === 'gpt-update-only')?.releaseDate).toBe('2025-08-01');
    expect(models.find((m) => m.id === 'gpt-no-dates')?.releaseDate).toBeUndefined();
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
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('error', { status: 500 }));

    await expect(fetchModelsDevCatalog()).rejects.toThrow('500');
  });

  it('throws on network error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('network error'));

    await expect(fetchModelsDevCatalog()).rejects.toThrow('network error');
  });
});
