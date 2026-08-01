import { describe, expect, it, vi } from 'vitest';
import {
  endpointPolicyError,
  endpointPolicyFetch,
} from '../../../core/providers/endpoint-policy.js';
import { createEndpointPolicyFetch } from '../../../lib/http/policy-fetch.js';
import { createClientFromProvider } from './connection.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

describe('createClientFromProvider', () => {
  setupFetchMock();

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
