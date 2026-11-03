import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  detectAvailableProviders,
  detectProviderCatalog,
  providerDetectionFromOutcome,
} from './catalog-detection.js';
import { KNOWN_PROVIDERS } from './registry.js';
import { PROVIDER_CATALOG_FAILURE_KINDS } from './types.js';
import { CLI_PROBE_TIMEOUT_MS } from '../constants.js';
import { probeActivitySnapshot } from '../probe-activity.js';
import { slowProbeText } from '../../core/discovery/probe-activity.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

type SlowAnswer = { afterMs: number; body: unknown } | 'never' | 'refused';

/**
 * Answers each request on the fake clock. Like the platform fetch, a pending request
 * rejects with its signal's reason when the signal aborts.
 */
function mockSlowFetch(answer: (url: string) => SlowAnswer): void {
  vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    const planned = answer(url.toString());
    if (planned === 'refused') return Promise.reject(new TypeError('Connection refused'));
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (planned !== 'never')
        setTimeout(() => resolve(jsonResponse(planned.body)), planned.afterMs);
    });
  });
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
    expect(results.length).toBe(Object.keys(KNOWN_PROVIDERS).length);

    const ollama = results.find((r) => r.provider === 'ollama');
    const lmStudio = results.find((r) => r.provider === 'lm-studio');

    expect(ollama).toMatchObject({
      available: true,
      models: [{ id: 'codellama:7b' }],
      isLocal: true,
    });
    expect(lmStudio).toMatchObject({
      available: false,
      failure: 'offline',
      error: 'Connection refused',
    });
    expect(lmStudio).not.toHaveProperty('models');
  });

  it('keeps successful metadata and valid empty inventories distinct', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        jsonResponse({ models: [{ name: 'qwen3-coder:30b', details: { family: 'qwen3' } }] }),
      )
      // The populated listing also observes /api/ps for load state.
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
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
      provider: 'lm-studio',
      configOverrides: { apiKey: 'sk-registry-policy-denied' },
    });

    expect(outcome).toEqual({
      kind: 'failed',
      source: 'provider-runtime',
      provider: 'lm-studio',
      isLocal: true,
      credential: 'present',
      failure: 'policy-denied',
      diagnostic: 'HTTP 403',
    });
  });

  it('validates a configured endpoint before attempting its credential reference', async () => {
    const outcome = await detectProviderCatalog({
      provider: 'lm-studio',
      configOverrides: {
        apiBase: 'https://untrusted.example/api/v1',
        apiKey: 'env:REGISTRY_MISSING_KEY',
      },
    });

    expect(outcome).toMatchObject({
      kind: 'failed',
      provider: 'lm-studio',
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
      provider: 'lm-studio',
      configOverrides: { apiKey: canary },
    });

    expect(outcome).toMatchObject({
      kind: 'failed',
      provider: 'lm-studio',
      credential: 'present',
      diagnostic: expect.stringContaining('***REDACTED***'),
    });
    expect(JSON.stringify(outcome)).not.toContain(canary);
  });

  describe('on the fake clock', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('counts a model list that answers after six seconds as found', async () => {
      vi.useFakeTimers();
      mockSlowFetch((url) => {
        if (url.includes('11434/api/tags')) {
          return { afterMs: 6_000, body: { models: [{ name: 'qwen2.5-coder:7b' }] } };
        }
        if (url.includes('11434/api/ps')) return { afterMs: 0, body: { models: [] } };
        return 'refused';
      });

      const pending = detectAvailableProviders();
      await vi.advanceTimersByTimeAsync(6_000);

      expect((await pending).find((r) => r.provider === 'ollama')).toMatchObject({
        available: true,
        models: [{ id: 'qwen2.5-coder:7b' }],
      });
    });

    // The scan once ended at five seconds; every model-list check now has the one-minute ceiling.
    it('ends a model list that never answers at the one-minute ceiling as a timeout', async () => {
      vi.useFakeTimers();
      mockSlowFetch(() => 'never');

      let settled = false;
      const pending = detectAvailableProviders().finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(CLI_PROBE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const local = (await pending).filter((r) => r.isLocal);
      expect(local.length).toBeGreaterThan(0);
      for (const r of local) {
        expect(r).toMatchObject({ available: false, failure: 'timeout' });
      }
    });

    it('names the provider and the check after ten seconds, and Esc stops the check', async () => {
      vi.useFakeTimers();
      mockSlowFetch(() => 'never');
      const esc = new AbortController();

      const pending = detectProviderCatalog({ provider: 'ollama', signal: esc.signal });
      const stopped = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(slowProbeText(probeActivitySnapshot().probes, Date.now())).toBe(
        'Ollama model list 10s',
      );

      esc.abort();
      await stopped;
      expect(probeActivitySnapshot().probes).toEqual([]);
    });
  });
});

describe('providerDetectionFromOutcome', () => {
  it.each(PROVIDER_CATALOG_FAILURE_KINDS)('carries a %s failure into the detection', (failure) => {
    expect(
      providerDetectionFromOutcome({
        kind: 'failed',
        source: 'provider-runtime',
        provider: 'lm-studio',
        isLocal: false,
        credential: 'present',
        failure,
        diagnostic: 'diagnostic under test',
      }),
    ).toEqual({
      provider: 'lm-studio',
      available: false,
      isLocal: false,
      hasKey: true,
      failure,
      error: 'diagnostic under test',
    });
  });
});
