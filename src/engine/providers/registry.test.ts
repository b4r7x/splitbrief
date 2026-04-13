import { describe, it, expect, vi } from 'vitest';
import { KNOWN_PROVIDERS, getProvider, detectAvailableProviders } from './registry.js';
import { setupFetchMock } from './testing.js';

describe('getProvider', () => {
  it('returns generic provider for unknown name', () => {
    const p = getProvider('custom-api', { apiBase: 'http://api.example.com/v1', apiKey: 'sk-test' });
    expect(p.name).toBe('custom-api');
    expect(p.baseURL).toBe('http://api.example.com/v1');
    expect(p.apiKey()).toBe('sk-test');
  });

  it('returns valid provider for known openai-compat name (deepseek)', () => {
    const p = getProvider('deepseek');
    expect(p.name).toBe('deepseek');
    expect(p.baseURL).toBe('https://api.deepseek.com/v1');
    expect(typeof p.apiKey()).toBe('string');
  });

  it('throws for unknown provider without apiBase', () => {
    expect(() => getProvider('unknown-provider')).toThrow(/apiBase/);
  });
});


describe('detectAvailableProviders', () => {
  setupFetchMock();

  it('returns detection for each known provider', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('11434')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen:7b' }] }), { status: 200 });
      }
      throw new Error('refused');
    });

    const results = await detectAvailableProviders();
    expect(results.length).toBe(Object.keys(KNOWN_PROVIDERS).length);

    const ollama = results.find((r) => r.provider === 'ollama');
    expect(ollama).toMatchObject({ available: true, models: [{ id: 'qwen:7b' }], isLocal: true });

    const deepseek = results.find((r) => r.provider === 'deepseek');
    expect(deepseek).toMatchObject({ available: false });
  });

  it('handles all providers failing', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('refused'));

    const results = await detectAvailableProviders();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });

  it('handles timeout', { timeout: 30000 }, async () => {
    vi.mocked(globalThis.fetch).mockReturnValue(new Promise<Response>(() => {}));

    const results = await detectAvailableProviders();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });
});
