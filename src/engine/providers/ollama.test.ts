import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOllamaProvider } from './ollama.js';

describe('createOllamaProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has correct defaults', () => {
    const p = createOllamaProvider();
    expect(p.name).toBe('ollama');
    expect(p.baseURL).toBe('http://localhost:11434/v1');
    expect(p.apiKey()).toBe('ollama');
    expect(p.isLocal).toBe(true);
  });

  it('respects overrides', () => {
    const p = createOllamaProvider({ apiBase: 'http://remote:11434/v1', apiKey: 'my-key' });
    expect(p.baseURL).toBe('http://remote:11434/v1');
    expect(p.apiKey()).toBe('my-key');
  });

  it('listModels parses Ollama tags response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ models: [{ name: 'qwen:7b' }, { name: 'llama3:8b' }] }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const p = createOllamaProvider();
    const models = await p.listModels();
    expect(models).toEqual(['qwen:7b', 'llama3:8b']);
    expect(globalThis.fetch).toHaveBeenCalledWith('http://localhost:11434/api/tags');
  });

  it('listModels returns empty on non-ok response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('error', { status: 500 }),
    ) as typeof globalThis.fetch;

    const p = createOllamaProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('isAvailable returns true when models exist', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ models: [{ name: 'test' }] }), { status: 200 }),
    ) as typeof globalThis.fetch;

    expect(await createOllamaProvider().isAvailable()).toBe(true);
  });

  it('isAvailable returns false on error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('refused'); }) as typeof globalThis.fetch;
    expect(await createOllamaProvider().isAvailable()).toBe(false);
  });

  it('detectContextLength parses num_ctx from parameters', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ parameters: 'num_ctx 32768\ntemperature 0.7' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const p = createOllamaProvider();
    expect(await p.detectContextLength!('qwen:7b')).toBe(32768);
  });

  it('detectContextLength returns null when no num_ctx', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ parameters: 'temperature 0.7' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const p = createOllamaProvider();
    expect(await p.detectContextLength!('qwen:7b')).toBeNull();
  });

  it('detectContextLength returns null on fetch error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('refused'); }) as typeof globalThis.fetch;
    const p = createOllamaProvider();
    expect(await p.detectContextLength!('qwen:7b')).toBeNull();
  });
});
