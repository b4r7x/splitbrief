import { describe, it, expect, vi } from 'vitest';
import { createOllamaProvider } from './ollama.js';
import { setupFetchMock } from './test-helpers.js';

describe('createOllamaProvider', () => {
  setupFetchMock();

  it('respects overrides', () => {
    const p = createOllamaProvider({ apiBase: 'http://remote:11434/v1', apiKey: 'my-key' });
    expect(p.baseURL).toBe('http://remote:11434/v1');
    expect(p.apiKey()).toBe('my-key');
  });

  it('listModels parses Ollama tags response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'qwen:7b' }, { name: 'llama3:8b' }] }), { status: 200 }),
    );

    const p = createOllamaProvider();
    const models = await p.listModels();
    expect(models).toEqual(['qwen:7b', 'llama3:8b']);
    expect(globalThis.fetch).toHaveBeenCalledWith('http://localhost:11434/api/tags');
  });

  it('listModels returns empty on non-ok response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('error', { status: 500 }));

    const p = createOllamaProvider();
    expect(await p.listModels()).toEqual([]);
  });

  it('detectContextLength parses num_ctx from parameters', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ parameters: 'num_ctx 32768\ntemperature 0.7' }), { status: 200 }),
    );

    const p = createOllamaProvider();
    expect(p.detectContextLength).toBeDefined();
    const result = await p.detectContextLength?.('qwen:7b');
    expect(result).toBe(32768);
  });

  it('detectContextLength returns null when no num_ctx', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ parameters: 'temperature 0.7' }), { status: 200 }),
    );

    const p = createOllamaProvider();
    expect(p.detectContextLength).toBeDefined();
    const result = await p.detectContextLength?.('qwen:7b');
    expect(result).toBeNull();
  });

  it('detectContextLength returns null on fetch error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('refused'));
    const p = createOllamaProvider();
    expect(p.detectContextLength).toBeDefined();
    const result = await p.detectContextLength?.('qwen:7b');
    expect(result).toBeNull();
  });
});
