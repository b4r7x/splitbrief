import { describe, it, expect, vi } from 'vitest';
import { KNOWN_PROVIDERS, getProvider, detectAvailableProviders, detectCapabilities } from './registry.js';
import { setupFetchMock } from './__test-helpers__.js';
import type { Config } from '../../core/schemas/config.js';

describe('getProvider', () => {
  setupFetchMock();

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

  it('lists Anthropic models with Anthropic headers', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'claude-sonnet-4-6', created_at: '2025-02-19T00:00:00Z' }],
        }),
        { status: 200 },
      ),
    );

    const provider = getProvider('anthropic', {
      apiBase: 'https://api.anthropic.com/v1',
      apiKey: 'sk-test',
    });
    const models = await provider.listModels();

    expect(models).toEqual(['claude-sonnet-4-6']);
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call?.[1]).toMatchObject({
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': 'sk-test',
      },
    });
  });
});


describe('detectCapabilities', () => {
  it('returns config contextLength for non-api implementer without throwing', async () => {
    const config = {
      implementer: { kind: 'cli' as const, tool: 'codex' as const, model: 'gpt-5.4-mini', contextLength: 32768 },
      planner: { kind: 'cli' as const, tool: 'claude-code' as const },
    } as Config;

    const result = await detectCapabilities(config);
    expect(result.contextLength).toBe(32768);
  });

  it('returns default 8192 for non-api implementer without contextLength', async () => {
    const config = {
      implementer: { kind: 'cli' as const, tool: 'codex' as const, model: 'gpt-5.4-mini' },
      planner: { kind: 'cli' as const, tool: 'claude-code' as const },
    } as Config;

    const result = await detectCapabilities(config);
    expect(result.contextLength).toBe(8192);
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
