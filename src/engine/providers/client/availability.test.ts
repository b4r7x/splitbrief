import { describe, it, expect, vi } from 'vitest';
import { CLI_PROBE_TIMEOUT_MS } from '../../constants.js';
import { getProvider } from '../registry.js';
import { createProviderAvailability, describeProviderUnavailability } from './availability.js';

describe('describeProviderUnavailability', () => {
  it('reports a missing key for a remote provider with no key', () => {
    expect(
      describeProviderUnavailability({ isLocal: false, hasKey: false, lastError: undefined }),
    ).toBe('no API key is configured');
  });

  it('surfaces the tracked last error when a remote provider has a key', () => {
    expect(
      describeProviderUnavailability({ isLocal: false, hasKey: true, lastError: 'HTTP 401' }),
    ).toBe('HTTP 401');
  });

  it('redacts credential-shaped tracked errors before presenting availability guidance', () => {
    const diagnostic = describeProviderUnavailability({
      isLocal: false,
      hasKey: true,
      lastError: 'upstream Authorization: Bearer canary-availability-secret',
    });
    expect(diagnostic).not.toContain('canary-availability-secret');
    expect(diagnostic).toContain('***REDACTED***');
  });

  it('reports an empty model list when a keyed remote provider tracked no error', () => {
    expect(
      describeProviderUnavailability({ isLocal: false, hasKey: true, lastError: undefined }),
    ).toBe('no models were returned');
  });

  it('reports an unreachable endpoint for a local provider with no tracked error', () => {
    expect(
      describeProviderUnavailability({ isLocal: true, hasKey: false, lastError: undefined }),
    ).toBe('the endpoint is unreachable');
  });

  it('sanitizes provider getLastError failures before returning guidance', () => {
    const credential = 'canary-availability-provider-2d10';
    const availability = createProviderAvailability({
      name: 'custom',
      baseURL: 'https://api.example.com/v1',
      apiKey: () => credential,
      isLocal: false,
      listModels: async () => [],
      getLastError: () => {
        throw new Error(`diagnostic Authorization: Bearer ${credential}`);
      },
    });

    const diagnostic = availability.unavailabilityReason() ?? '';
    expect(diagnostic).not.toContain(credential);
    expect(diagnostic).toContain('***REDACTED***');
  });

  it('names a model list that did not answer within the probe ceiling as the reason', async () => {
    vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const availability = createProviderAvailability(
        getProvider('ollama', { apiBase: 'http://127.0.0.1:11434/v1' }),
      );
      const pending = availability.isAvailable();

      await vi.advanceTimersByTimeAsync(CLI_PROBE_TIMEOUT_MS);

      expect(await pending).toBe(false);
      expect(availability.unavailabilityReason()).toBe('the model list did not answer in time');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
