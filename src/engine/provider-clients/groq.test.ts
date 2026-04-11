import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGroqProvider } from './groq.js';

describe('createGroqProvider', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.GROQ_API_KEY;
    } else {
      process.env.GROQ_API_KEY = originalEnv;
    }
  });

  it('creates provider with correct properties', () => {
    const p = createGroqProvider();
    expect(p.name).toBe('groq');
    expect(p.baseURL).toBe('https://api.groq.com/openai/v1');
    expect(p.isLocal).toBe(false);
  });

  it('respects overrides', () => {
    const p = createGroqProvider({
      apiBase: 'https://custom.groq.com/v1',
      apiKey: 'custom-key',
    });
    expect(p.baseURL).toBe('https://custom.groq.com/v1');
    expect(p.apiKey()).toBe('custom-key');
  });

  it('listModels returns model IDs', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'llama3-8b-8192', context_window: 8192 },
            { id: 'mixtral-8x7b-32768', context_window: 32768 },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createGroqProvider();
    const models = await p.listModels();

    expect(models).toEqual(['llama3-8b-8192', 'mixtral-8x7b-32768']);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: 'Bearer test-key' },
    });
  });

  it('listModelsWithMetadata returns full metadata', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'llama3-70b-8192', context_window: 8192 },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createGroqProvider();
    const models = await p.listModelsWithMetadata();

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: 'llama3-70b-8192',
      contextLength: 8192,
    });
  });

  it('detectContextLength returns context length for known model', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'mixtral-8x7b-32768', context_window: 32768 }],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createGroqProvider();
    expect(await p.detectContextLength('mixtral-8x7b-32768')).toBe(32768);
  });

  it('detectContextLength returns null for unknown model', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'other-model', context_window: 4096 }],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createGroqProvider();
    expect(await p.detectContextLength('unknown-model')).toBeNull();
  });

  it('returns empty array when no API key', async () => {
    delete process.env.GROQ_API_KEY;
    const p = createGroqProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('returns empty array on non-ok response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('error', { status: 500 })) as typeof globalThis.fetch;

    const p = createGroqProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('returns empty array on fetch error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network error');
    }) as typeof globalThis.fetch;

    const p = createGroqProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('returns empty array on invalid response shape', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ invalid: 'shape' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const p = createGroqProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('handles model without context_window', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'minimal-model' }],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const p = createGroqProvider();
    const models = await p.listModelsWithMetadata();

    expect(models).toEqual([{ id: 'minimal-model' }]);
  });
});
