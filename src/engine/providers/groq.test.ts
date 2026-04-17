import { describe, it, expect, vi } from 'vitest';
import { createGroqProvider } from './groq.js';
import { setupFetchMock, setupEnvMock } from './test-helpers.js';

describe('createGroqProvider', () => {
  setupFetchMock();
  setupEnvMock('GROQ_API_KEY', 'test-key');

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
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'llama3-8b-8192', context_window: 8192 },
            { id: 'mixtral-8x7b-32768', context_window: 32768 },
          ],
        }),
        { status: 200 },
      ),
    );

    const p = createGroqProvider();
    const models = await p.listModels();

    expect(models).toEqual(['llama3-8b-8192', 'mixtral-8x7b-32768']);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: 'Bearer test-key' },
    });
  });

  it('listModelsWithMetadata returns full metadata', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'llama3-70b-8192', context_window: 8192 },
          ],
        }),
        { status: 200 },
      ),
    );

    const p = createGroqProvider();
    const models = await p.listModelsWithMetadata();

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: 'llama3-70b-8192',
      contextLength: 8192,
    });
  });

  it('detectContextLength returns context length for known model', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'mixtral-8x7b-32768', context_window: 32768 }],
        }),
        { status: 200 },
      ),
    );

    const p = createGroqProvider();
    expect(await p.detectContextLength('mixtral-8x7b-32768')).toBe(32768);
  });

  it('detectContextLength returns null for unknown model', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'other-model', context_window: 4096 }],
        }),
        { status: 200 },
      ),
    );

    const p = createGroqProvider();
    expect(await p.detectContextLength('unknown-model')).toBeNull();
  });

  it('returns empty array when no API key', async () => {
    delete process.env.GROQ_API_KEY;
    const p = createGroqProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('returns empty array on non-ok response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('error', { status: 500 }));

    const p = createGroqProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('returns empty array on fetch error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('network error'));

    const p = createGroqProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('returns empty array on invalid response shape', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ invalid: 'shape' }), { status: 200 }),
    );

    const p = createGroqProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('handles model without context_window', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'minimal-model' }],
        }),
        { status: 200 },
      ),
    );

    const p = createGroqProvider();
    const models = await p.listModelsWithMetadata();

    expect(models).toEqual([{ id: 'minimal-model' }]);
  });
});
