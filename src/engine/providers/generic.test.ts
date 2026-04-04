import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGenericProvider } from './generic.js';

describe('createGenericProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses provided name and baseURL', () => {
    const p = createGenericProvider('my-api', 'http://api.example.com/v1', 'sk-123');
    expect(p.name).toBe('my-api');
    expect(p.baseURL).toBe('http://api.example.com/v1');
    expect(p.apiKey()).toBe('sk-123');
    expect(p.isLocal).toBe(false);
  });

  it('falls back to env var for apiKey', () => {
    process.env.MY_API_API_KEY = 'from-env';
    const p = createGenericProvider('my-api', 'http://api.example.com/v1');
    expect(p.apiKey()).toBe('from-env');
    delete process.env.MY_API_API_KEY;
  });

  it('listModels returns empty on fetch error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('refused'); }) as typeof globalThis.fetch;
    const p = createGenericProvider('test', 'http://localhost:9999/v1');
    expect(await p.listModels()).toEqual([]);
  });

  it('listModels parses OpenAI-style response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'model-1' }] }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const p = createGenericProvider('test', 'http://localhost:9999/v1');
    expect(await p.listModels()).toEqual(['model-1']);
  });

  it('does not have detectContextLength', () => {
    const p = createGenericProvider('test', 'http://localhost:9999/v1');
    expect(p.detectContextLength).toBeUndefined();
  });
});
