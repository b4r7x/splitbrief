import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  endpointPolicyError,
  endpointPolicyFetch,
} from '../../../core/providers/endpoint-policy.js';
import { createEndpointPolicyFetch } from '../../../lib/http/policy-fetch.js';
import { createClientFromProvider } from './connection.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { getProvider } from '../registry.js';

describe('createClientFromProvider', () => {
  setupFetchMock();
  afterEach(() => vi.unstubAllEnvs());

  it.each(['lm-studio', 'llama-cpp'])(
    'uses the installed SDK without authentication for unkeyed %s',
    async (name) => {
      vi.stubEnv('LM_STUDIO_API_KEY', '');
      vi.stubEnv('OPENAI_API_KEY', 'sk-ambient-fixture');
      vi.stubEnv('OPENAI_ADMIN_KEY', 'sk-admin-fixture');
      vi.stubEnv('OPENAI_CUSTOM_HEADERS', 'Authorization: Bearer ambient\napi-key: ambient');
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ object: 'list', data: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
      const provider = getProvider(name);
      expect(provider.apiKey()).toBe('');
      expect(provider.dispatchAuthentication?.()).toBe('none');

      const client = createClientFromProvider(provider);
      await client.models.list();

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [input, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
      const request = new Request(input, init);
      expect(request.headers.has('authorization')).toBe(false);
      expect(request.headers.has('api-key')).toBe(false);
      expect(request.url).toBe(`${provider.baseURL}/models`);
      expect(client.maxRetries).toBe(0);
      expect(provider.apiKey()).toBe('');
      expect(provider.dispatchAuthentication?.()).toBe('none');
    },
  );

  it('sends a configured local credential and keeps its authentication evidence', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', data: [] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = getProvider('lm-studio', { apiKey: 'configured-local-fixture' });
    await createClientFromProvider(provider).models.list();
    const [input, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(new Request(input, init).headers.get('authorization')).toBe(
      'Bearer configured-local-fixture',
    );
    expect(provider.dispatchAuthentication?.()).toBe('api-key');
  });

  it('fails closed before reading credentials when policy-owned transport is absent', () => {
    const apiKey = vi.fn(() => 'secret');
    const provider = {
      name: 'unregistered',
      baseURL: 'https://api.example.com/v1',
      apiKey,
      isLocal: false,
      listModels: async () => [],
    };

    expect(() => createClientFromProvider(provider)).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-policy-unsupported' }),
    );
    expect(apiKey).not.toHaveBeenCalled();
  });

  it('fails closed when the policy transport slot holds a non-callable value', () => {
    const apiKey = vi.fn(() => 'secret');
    const provider = {
      name: 'unregistered',
      baseURL: 'https://api.example.com/v1',
      apiKey,
      isLocal: false,
      listModels: async () => [],
      [endpointPolicyFetch]: null as unknown as ReturnType<typeof createEndpointPolicyFetch>,
    };

    expect(() => createClientFromProvider(provider)).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-policy-unsupported' }),
    );
    expect(apiKey).not.toHaveBeenCalled();
  });

  it('uses the provider policy fetch for OpenAI client requests', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.net/collect' },
      }),
    );
    const provider = {
      name: 'test',
      baseURL: 'https://api.example.com/v1',
      apiKey: () => 'secret',
      isLocal: false,
      listModels: async () => [],
      [endpointPolicyFetch]: createEndpointPolicyFetch(
        'https://api.example.com/v1',
        endpointPolicyError.invalid,
      ),
    };

    const client = createClientFromProvider(provider);
    await expect(client.models.list()).rejects.toMatchObject({
      cause: { kind: 'provider-endpoint-invalid' },
    });
    for (const [input] of vi.mocked(globalThis.fetch).mock.calls) {
      const url = input instanceof Request ? input.url : input.toString();
      expect(new URL(url).origin).toBe('https://api.example.com');
    }
  });
});
