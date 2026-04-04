import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KNOWN_PROVIDERS, getProvider, detectAvailableProviders } from './registry.js';

describe('KNOWN_PROVIDERS', () => {
  it('contains all four known providers', () => {
    expect(Object.keys(KNOWN_PROVIDERS)).toEqual(['ollama', 'lm-studio', 'deepseek', 'openrouter']);
  });

  it('each factory returns a ProviderDef', () => {
    for (const [name, factory] of Object.entries(KNOWN_PROVIDERS)) {
      const p = factory();
      expect(p.name).toBe(name);
      expect(typeof p.baseURL).toBe('string');
      expect(typeof p.apiKey).toBe('function');
      expect(typeof p.isLocal).toBe('boolean');
      expect(typeof p.listModels).toBe('function');
      expect(typeof p.isAvailable).toBe('function');
    }
  });
});

describe('getProvider', () => {
  it('returns known provider by name', () => {
    const p = getProvider('ollama');
    expect(p.name).toBe('ollama');
    expect(p.baseURL).toContain('11434');
  });

  it('applies overrides to known provider', () => {
    const p = getProvider('ollama', { apiBase: 'http://remote:11434/v1' });
    expect(p.baseURL).toBe('http://remote:11434/v1');
  });

  it('returns generic provider for unknown name', () => {
    const p = getProvider('custom-api', { apiBase: 'http://api.example.com/v1', apiKey: 'sk-test' });
    expect(p.name).toBe('custom-api');
    expect(p.baseURL).toBe('http://api.example.com/v1');
    expect(p.apiKey()).toBe('sk-test');
  });
});

describe('detectAvailableProviders', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns detection for each known provider', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('11434')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen:7b' }] }), { status: 200 });
      }
      throw new Error('refused');
    }) as typeof globalThis.fetch;

    const results = await detectAvailableProviders();
    expect(results.length).toBe(Object.keys(KNOWN_PROVIDERS).length);

    const ollama = results.find((r) => r.provider === 'ollama');
    expect(ollama).toBeTruthy();
    expect(ollama!.available).toBe(true);
    expect(ollama!.models).toEqual(['qwen:7b']);
    expect(ollama!.isLocal).toBe(true);

    const deepseek = results.find((r) => r.provider === 'deepseek');
    expect(deepseek).toBeTruthy();
    expect(deepseek!.available).toBe(false);
  });

  it('handles all providers failing', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('refused'); }) as typeof globalThis.fetch;

    const results = await detectAvailableProviders();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });

  it('handles timeout', { timeout: 30000 }, async () => {
    globalThis.fetch = vi.fn(async () => new Promise<Response>(() => {})) as typeof globalThis.fetch;

    const results = await detectAvailableProviders();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });
});
