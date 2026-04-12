import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOpenRouterProvider, parsePrice, toDetectedModel } from './openrouter.js';

describe('parsePrice', () => {
  it('returns 0 for undefined', () => {
    expect(parsePrice(undefined)).toBe(0);
  });

  it('returns 0 for "0"', () => {
    expect(parsePrice('0')).toBe(0);
  });

  it('converts per-token price to per-1M tokens', () => {
    // 0.000005 per token = 5 per 1M tokens
    expect(parsePrice('0.000005')).toBe(5);
  });

  it('handles larger prices', () => {
    // 0.015 per token = 15000 per 1M tokens
    expect(parsePrice('0.015')).toBe(15000);
  });

  it('returns 0 for invalid string', () => {
    expect(parsePrice('not-a-number')).toBe(0);
  });
});

describe('toDetectedModel', () => {
  it('detects FREE models by :free suffix', () => {
    const model = toDetectedModel({
      id: 'meta-llama/llama-3-8b-instruct:free',
      context_length: 8192,
      pricing: { prompt: '0.001', completion: '0.002' },
    });

    expect(model.isFree).toBe(true);
    expect(model.id).toBe('meta-llama/llama-3-8b-instruct:free');
  });

  it('detects FREE models by zero pricing', () => {
    const model = toDetectedModel({
      id: 'some-model/free-model',
      context_length: 4096,
      pricing: { prompt: '0', completion: '0' },
    });

    expect(model.isFree).toBe(true);
  });

  it('marks non-free models correctly', () => {
    const model = toDetectedModel({
      id: 'openai/gpt-4o',
      context_length: 128000,
      pricing: { prompt: '0.000005', completion: '0.000015' },
    });

    expect(model.isFree).toBe(false);
    expect(model.pricingInput).toBe(5);
    expect(model.pricingOutput).toBe(15);
  });

  it('extracts context_length', () => {
    const model = toDetectedModel({
      id: 'anthropic/claude-3-opus',
      context_length: 200000,
    });

    expect(model.contextLength).toBe(200000);
  });

  it('extracts vision capability from architecture', () => {
    const model = toDetectedModel({
      id: 'openai/gpt-4o',
      architecture: {
        modality: {
          input: ['text', 'image'],
          output: ['text'],
        },
      },
    });

    expect(model.capabilities).toEqual(['vision']);
  });

  it('returns undefined capabilities when no image input', () => {
    const model = toDetectedModel({
      id: 'openai/gpt-4',
      architecture: {
        modality: {
          input: ['text'],
          output: ['text'],
        },
      },
    });

    expect(model.capabilities).toBeUndefined();
  });

  it('handles missing optional fields', () => {
    const model = toDetectedModel({ id: 'minimal-model' });

    expect(model.id).toBe('minimal-model');
    expect(model.contextLength).toBeUndefined();
    expect(model.pricingInput).toBe(0);
    expect(model.pricingOutput).toBe(0);
    expect(model.isFree).toBe(true); // zero pricing = free
    expect(model.capabilities).toBeUndefined();
  });
});

describe('createOpenRouterProvider', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalEnv;
    }
  });

  it('uses default base URL', () => {
    const p = createOpenRouterProvider();
    expect(p.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('respects overrides', () => {
    const p = createOpenRouterProvider({
      apiBase: 'https://custom.openrouter.ai/v1',
      apiKey: 'custom-key',
    });
    expect(p.baseURL).toBe('https://custom.openrouter.ai/v1');
    expect(p.apiKey()).toBe('custom-key');
  });

  it('listModels returns model IDs', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'openai/gpt-4o', context_length: 128000 },
            { id: 'anthropic/claude-3-opus', context_length: 200000 },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createOpenRouterProvider();
    const models = await p.listModels();

    expect(models).toEqual(['openai/gpt-4o', 'anthropic/claude-3-opus']);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: 'Bearer test-key' },
    });
  });

  it('listModelsWithMetadata returns full metadata', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'openai/gpt-4o',
              context_length: 128000,
              pricing: { prompt: '0.000005', completion: '0.000015' },
              architecture: { modality: { input: ['text', 'image'], output: ['text'] } },
            },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createOpenRouterProvider();
    const models = await p.listModelsWithMetadata();

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: 'openai/gpt-4o',
      contextLength: 128000,
      pricingInput: 5,
      pricingOutput: 15,
      isFree: false,
      capabilities: ['vision'],
    });
  });

  it('detectContextLength returns context length for known model', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'anthropic/claude-3-opus', context_length: 200000 }],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createOpenRouterProvider();
    expect(await p.detectContextLength('anthropic/claude-3-opus')).toBe(200000);
  });

  it('detectContextLength returns null for unknown model', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'other-model', context_length: 4096 }],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createOpenRouterProvider();
    expect(await p.detectContextLength('unknown-model')).toBeNull();
  });

  it('returns empty array when no API key', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const p = createOpenRouterProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('returns empty array on non-ok response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('error', { status: 500 })) as typeof globalThis.fetch;

    const p = createOpenRouterProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('returns empty array on fetch error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network error');
    }) as typeof globalThis.fetch;

    const p = createOpenRouterProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('returns empty array on invalid response shape', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ invalid: 'shape' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const p = createOpenRouterProvider();
    expect(await p.listModels()).toEqual([]);
  });

});
