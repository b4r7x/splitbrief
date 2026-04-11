import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTogetherProvider } from './together.js';

describe('createTogetherProvider', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = process.env.TOGETHER_API_KEY;
    process.env.TOGETHER_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.TOGETHER_API_KEY;
    } else {
      process.env.TOGETHER_API_KEY = originalEnv;
    }
  });

  it('creates provider with correct properties', () => {
    const p = createTogetherProvider();
    expect(p.name).toBe('together');
    expect(p.baseURL).toBe('https://api.together.xyz/v1');
    expect(p.isLocal).toBe(false);
  });

  it('respects overrides', () => {
    const p = createTogetherProvider({
      apiBase: 'https://custom.together.xyz/v1',
      apiKey: 'custom-key',
    });
    expect(p.baseURL).toBe('https://custom.together.xyz/v1');
    expect(p.apiKey()).toBe('custom-key');
  });

  it('listModels returns model IDs', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'meta-llama/Llama-3-8b-chat-hf', context_length: 8192 },
            { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', context_length: 32768 },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createTogetherProvider();
    const models = await p.listModels();

    expect(models).toEqual(['meta-llama/Llama-3-8b-chat-hf', 'mistralai/Mixtral-8x7B-Instruct-v0.1']);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.together.xyz/v1/models', {
      headers: { Authorization: 'Bearer test-key' },
    });
  });

  it('listModelsWithMetadata returns full metadata with pricing', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'meta-llama/Llama-3-70b-chat-hf',
              context_length: 8192,
              pricing: { input: 0.0000009, output: 0.0000009 },
            },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createTogetherProvider();
    const models = await p.listModelsWithMetadata();

    expect(models).toEqual([{
      id: 'meta-llama/Llama-3-70b-chat-hf',
      contextLength: 8192,
      pricingInput: expect.closeTo(0.9, 5),
      pricingOutput: expect.closeTo(0.9, 5),
    }]);
  });

  it('detectContextLength returns context length for known model', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', context_length: 32768 }],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createTogetherProvider();
    expect(await p.detectContextLength('mistralai/Mixtral-8x7B-Instruct-v0.1')).toBe(32768);
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

    const p = createTogetherProvider();
    expect(await p.detectContextLength('unknown-model')).toBeNull();
  });

  it('returns empty array when no API key', async () => {
    delete process.env.TOGETHER_API_KEY;
    const p = createTogetherProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('returns empty array on non-ok response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('error', { status: 500 })) as typeof globalThis.fetch;

    const p = createTogetherProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('returns empty array on fetch error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network error');
    }) as typeof globalThis.fetch;

    const p = createTogetherProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('returns empty array on invalid response shape', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ invalid: 'shape' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const p = createTogetherProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('handles model without context_length or pricing', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'minimal-model' }],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createTogetherProvider();
    const models = await p.listModelsWithMetadata();

    expect(models).toEqual([{ id: 'minimal-model' }]);
  });

  it('handles model with partial pricing', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'partial-pricing-model',
              context_length: 4096,
              pricing: { input: 0.000001 },
            },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createTogetherProvider();
    const models = await p.listModelsWithMetadata();

    expect(models).toEqual([{
      id: 'partial-pricing-model',
      contextLength: 4096,
      pricingInput: 1,
    }]);
  });
});
