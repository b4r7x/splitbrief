import { describe, it, expect, vi } from 'vitest';
import {
  detectAvailableProviders,
  detectProviderCatalog,
  providerDetectionFromOutcome,
} from './catalog-detection.js';
import { KNOWN_PROVIDERS } from './registry.js';
import { PROVIDER_CATALOG_FAILURE_KINDS } from './types.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function mockFetchRoutes(
  routes: Readonly<Record<string, unknown>>,
  fallback: () => Response = () => new Response('', { status: 404 }),
): void {
  vi.mocked(globalThis.fetch).mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (const [needle, body] of Object.entries(routes)) {
      if (urlStr.includes(needle)) return jsonResponse(body);
    }
    return fallback();
  });
}

describe('detectAvailableProviders', () => {
  setupFetchMock();

  it('returns results for ollama and lm-studio', async () => {
    mockFetchRoutes({
      '11434': { models: [{ name: 'qwen2.5-coder:7b' }, { name: 'llama3:8b' }] },
      '1234': { models: [{ key: 'deepseek-coder-v2', type: 'llm' }] },
    });

    const results = await detectAvailableProviders();
    const ollama = results.find((r) => r.provider === 'ollama');
    expect(ollama).toMatchObject({
      available: true,
      models: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3:8b' }],
    });
    expect(ollama).not.toHaveProperty('failure');

    const lmStudio = results.find((r) => r.provider === 'lm-studio');
    expect(lmStudio).toMatchObject({ available: true, models: [{ id: 'deepseek-coder-v2' }] });
  });

  it('handles ollama running but lm-studio not running', async () => {
    mockFetchRoutes({ '11434': { models: [{ name: 'codellama:7b' }] } }, () => {
      throw new Error('Connection refused');
    });

    const results = await detectAvailableProviders();
    const ollama = results.find((r) => r.provider === 'ollama');
    const lmStudio = results.find((r) => r.provider === 'lm-studio');

    expect(ollama).toMatchObject({ available: true, models: [{ id: 'codellama:7b' }] });
    expect(lmStudio).toMatchObject({
      available: false,
      failure: 'offline',
      error: 'Connection refused',
    });
    expect(lmStudio).not.toHaveProperty('models');
  });

  it('returns detection for each known provider', async () => {
    mockFetchRoutes({ '11434': { models: [{ name: 'qwen:7b' }] } }, () => {
      throw new Error('refused');
    });

    const results = await detectAvailableProviders();
    expect(results.length).toBe(Object.keys(KNOWN_PROVIDERS).length);

    const ollama = results.find((r) => r.provider === 'ollama');
    expect(ollama).toMatchObject({ available: true, models: [{ id: 'qwen:7b' }], isLocal: true });

    const deepseek = results.find((r) => r.provider === 'deepseek');
    expect(deepseek).toMatchObject({ available: false });
  });

  it('keeps successful metadata and valid empty inventories distinct', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        jsonResponse({ models: [{ name: 'qwen3-coder:30b', details: { family: 'qwen3' } }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ models: [] }));

    const populated = await detectProviderCatalog({ provider: 'ollama' });
    const empty = await detectProviderCatalog({ provider: 'ollama' });

    expect(populated).toMatchObject({
      kind: 'success',
      source: 'provider-runtime',
      provider: 'ollama',
      catalog: 'populated',
      models: [{ id: 'qwen3-coder:30b', providerId: 'ollama', capabilities: ['family:qwen3'] }],
    });
    expect(empty).toEqual({
      kind: 'success',
      source: 'provider-runtime',
      provider: 'ollama',
      isLocal: true,
      credential: 'not-required',
      catalog: 'empty',
      models: [],
    });
  });

  it('projects a valid empty inventory as reachable rather than a failed discovery', async () => {
    mockFetchRoutes({ '11434': { models: [] }, '1234': { models: [] } });

    const results = await detectAvailableProviders();
    expect(results.find((result) => result.provider === 'ollama')).toEqual({
      provider: 'ollama',
      available: true,
      isLocal: true,
      models: [],
    });
  });

  it('classifies exact sanitized HTTP 403 as policy denial instead of valid empty', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 403 }));

    const outcome = await detectProviderCatalog({
      provider: 'openai',
      configOverrides: { apiKey: 'sk-registry-policy-denied' },
    });

    expect(outcome).toEqual({
      kind: 'failed',
      source: 'provider-runtime',
      provider: 'openai',
      isLocal: false,
      credential: 'present',
      failure: 'policy-denied',
      diagnostic: 'HTTP 403',
    });
  });

  it.each([
    ['privacy_data_collection_restricted', 'privacy-filtered'],
    ['guardrail_rejected', 'guardrail-filtered'],
  ] as const)('preserves OpenRouter %s as a typed %s catalog failure', async (code, failure) => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { code } }), { status: 403 }),
    );

    const outcome = await detectProviderCatalog({
      provider: 'openrouter',
      configOverrides: { apiKey: 'sk-or-filtered' },
    });

    expect(outcome).toMatchObject({
      kind: 'failed',
      provider: 'openrouter',
      failure,
    });
  });

  it('validates a configured endpoint before attempting its credential reference', async () => {
    const outcome = await detectProviderCatalog({
      provider: 'openrouter',
      configOverrides: {
        apiBase: 'https://untrusted.example/api/v1',
        apiKey: 'env:REGISTRY_MISSING_KEY',
      },
    });

    expect(outcome).toMatchObject({
      kind: 'failed',
      provider: 'openrouter',
      failure: 'endpoint-invalid',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('handles all providers failing', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('refused'));

    const results = await detectAvailableProviders();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });

  it('redacts configured credentials from typed catalog failures', async () => {
    const canary = 'sk-canary-registry-credential-6e2a';
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new Error(`upstream Authorization: Bearer ${canary}`),
    );

    const outcome = await detectProviderCatalog({
      provider: 'openai',
      configOverrides: { apiKey: canary },
    });

    expect(outcome).toMatchObject({
      kind: 'failed',
      provider: 'openai',
      credential: 'present',
      diagnostic: expect.stringContaining('***REDACTED***'),
    });
    expect(JSON.stringify(outcome)).not.toContain(canary);
  });

  it('handles timeout', { timeout: 30000 }, async () => {
    vi.mocked(globalThis.fetch).mockReturnValue(new Promise<Response>(() => {}));

    const results = await detectAvailableProviders();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });
});

describe('providerDetectionFromOutcome', () => {
  it.each(PROVIDER_CATALOG_FAILURE_KINDS)('carries a %s failure into the detection', (failure) => {
    expect(
      providerDetectionFromOutcome({
        kind: 'failed',
        source: 'provider-runtime',
        provider: 'openai',
        isLocal: false,
        credential: 'present',
        failure,
        diagnostic: 'diagnostic under test',
      }),
    ).toEqual({
      provider: 'openai',
      available: false,
      isLocal: false,
      hasKey: true,
      failure,
      error: 'diagnostic under test',
    });
  });
});
