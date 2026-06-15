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
  it('maps Models.dev models to DetectedModel[]', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    expect(models).toHaveLength(2);
    expect(models.at(0)?.id).toBe('claude-sonnet-4-6');
    expect(models.at(1)?.id).toBe('claude-haiku-3');
  });

  it('keeps models.dev pricing in per-1M-token units', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.pricingInput).toBe(3);
    expect(sonnet?.pricingOutput).toBe(15);
  });

  it('carries models.dev cache_read/cache_write through to detected pricing fields', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.pricingCacheRead).toBe(0.3);
    expect(sonnet?.pricingCacheWrite).toBe(3.75);
  });

  it('leaves cache pricing undefined when models.dev omits it', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    const haiku = models.find((m) => m.id === 'claude-haiku-3');
    expect(haiku?.pricingCacheRead).toBeUndefined();
    expect(haiku?.pricingCacheWrite).toBeUndefined();
  });

  it('extracts contextLength from limit.context', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.contextLength).toBe(200000);
  });

  it('surfaces maxOutputTokens from limit.output', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.maxOutputTokens).toBe(8192);
  });

  it('leaves maxOutputTokens undefined when limit.output is absent', () => {
    const models = getModelsForProvider(FIXTURE, 'together');
    expect(models.at(0)?.maxOutputTokens).toBeUndefined();
  });

  it('carries models.dev capability flags into the detected model', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.supportsTemperature).toBe(true);
    expect(sonnet?.supportsReasoning).toBe(true);
    expect(sonnet?.supportsImages).toBe(true);
  });

  it('leaves capability flags undefined when models.dev omits them', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    const haiku = models.find((m) => m.id === 'claude-haiku-3');
    expect(haiku?.supportsTemperature).toBeUndefined();
    expect(haiku?.supportsReasoning).toBeUndefined();
    expect(haiku?.supportsImages).toBeUndefined();
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

  it('maps github-copilot provider ID to copilot', () => {
    const models = getModelsForProvider(FIXTURE, 'copilot');
    expect(models).toHaveLength(1);
    expect(models.at(0)?.id).toBe('claude-opus-4.6');
  });

  it('maps kilo provider ID to kilo-code', () => {
    const models = getModelsForProvider(FIXTURE, 'kilo-code');
    expect(models).toHaveLength(1);
    expect(models.at(0)?.id).toBe('kimi-k2.5');
  });

  it('merges opencode and opencode-go provider IDs for opencode', () => {
    const models = getModelsForProvider(FIXTURE, 'opencode');
    expect(models).toHaveLength(2);
    expect(models.map((model) => model.id)).toEqual(
      expect.arrayContaining(['claude-sonnet-4-6', 'gpt-5.4']),
    );
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
