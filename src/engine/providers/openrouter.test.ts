import { describe, it, expect, vi } from 'vitest';
import { createOpenRouterProvider, parsePrice, toDetectedModel } from './openrouter.js';
import { setupFetchMock, setupEnvMock } from '#testing/helpers/fetch-mock.js';

type FakeServer = Readonly<{
  fetch: typeof globalThis.fetch;
  requests: Request[];
}>;

function fakeServer(handler: (request: Request) => Promise<Response> | Response): FakeServer {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    return handler(request);
  };
  return { fetch, requests };
}

// Shared provider contract (listModels / detectContextLength / error paths / overrides)
// lives in provider-contract.test.ts. This file covers OpenRouter-specific pure helpers
// (price parsing, model→DetectedModel transformation) and the metadata fetch shape.

describe('parsePrice', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['0', 0],
    ['0.000005', 5],
    ['0.015', 15000],
    ['-0.000005', undefined],
    ['not-a-number', undefined],
  ] as const)('parsePrice(%s) => %s', (input, expected) => {
    expect(parsePrice(input)).toBe(expected);
  });
});

describe('toDetectedModel', () => {
  it('detects FREE models by :free suffix', () => {
    const model = toDetectedModel({
      id: 'meta-llama/llama-3-8b-instruct:free',
      context_length: 8192,
      pricing: { prompt: '0.001', completion: '0.002' },
    });

    expect(model.isFree).toBe(true);
    expect(model.id).toBe('meta-llama/llama-3-8b-instruct:free');
  });

  it('detects FREE models by zero pricing', () => {
    const model = toDetectedModel({
      id: 'some-model/free-model',
      context_length: 4096,
      pricing: { prompt: '0', completion: '0' },
    });

    expect(model.isFree).toBe(true);
  });

  it('marks non-free models correctly', () => {
    const model = toDetectedModel({
      id: 'openai/gpt-4o',
      context_length: 128000,
      pricing: { prompt: '0.000005', completion: '0.000015' },
    });

    expect(model.isFree).toBe(false);
    expect(model.pricingInput).toBe(5);
    expect(model.pricingOutput).toBe(15);
  });

  it('maps input_cache_read/input_cache_write into cache pricing fields (per-1M units)', () => {
    const model = toDetectedModel({
      id: 'anthropic/claude-sonnet-4.6',
      pricing: {
        prompt: '0.000003',
        completion: '0.000015',
        input_cache_read: '0.0000003',
        input_cache_write: '0.00000375',
      },
    });

    expect(model.pricingCacheRead).toBe(0.3);
    expect(model.pricingCacheWrite).toBe(3.75);
  });

  it('leaves cache pricing undefined when OpenRouter omits cache rates', () => {
    const model = toDetectedModel({
      id: 'openai/gpt-4o',
      pricing: { prompt: '0.000005', completion: '0.000015' },
    });

    expect(model.pricingCacheRead).toBeUndefined();
    expect(model.pricingCacheWrite).toBeUndefined();
  });

  it('extracts context_length', () => {
    const model = toDetectedModel({
      id: 'anthropic/claude-3-opus',
      context_length: 200000,
    });

    expect(model.contextLength).toBe(200000);
  });

  it('extracts vision capability from architecture', () => {
    const model = toDetectedModel({
      id: 'openai/gpt-4o',
      architecture: {
        modality: {
          input: ['text', 'image'],
          output: ['text'],
        },
      },
    });

    expect(model.capabilities).toEqual(['vision']);
  });

  it('extracts vision capability from input_modalities', () => {
    const model = toDetectedModel({
      id: 'openai/gpt-4o',
      architecture: {
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
      },
    });

    expect(model.capabilities).toEqual(['vision']);
  });

  it('returns undefined capabilities when no image input', () => {
    const model = toDetectedModel({
      id: 'openai/gpt-4',
      architecture: {
        modality: {
          input: ['text'],
          output: ['text'],
        },
      },
    });

    expect(model.capabilities).toBeUndefined();
  });

  it('handles missing optional fields', () => {
    const model = toDetectedModel({ id: 'minimal-model' });

    expect(model.id).toBe('minimal-model');
    expect(model.contextLength).toBeUndefined();
    expect(model.pricingInput).toBeUndefined();
    expect(model.pricingOutput).toBeUndefined();
    expect(model.isFree).toBeUndefined();
    expect(model.capabilities).toBeUndefined();
  });

  it('omits malformed pricing instead of treating it as free', () => {
    const model = toDetectedModel({
      id: 'openai/gpt-4o',
      pricing: { prompt: 'not-a-number', completion: '0' },
    });

    expect(model.pricingInput).toBeUndefined();
    expect(model.pricingOutput).toBe(0);
    expect(model.isFree).toBeUndefined();
  });
});

describe('createOpenRouterProvider listModelsWithMetadata', () => {
  setupFetchMock();
  setupEnvMock('OPENROUTER_API_KEY', 'sk-or-test-key');

  it('uses the account-filtered catalog for membership and enriches only matching IDs from the public catalog', async () => {
    const server = fakeServer((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/models/user') {
        expect(request.headers.get('authorization')).toBe('Bearer sk-or-test-key');
        return new Response(
          JSON.stringify({ data: [{ id: 'openai/account-visible', context_length: 65_536 }] }),
          { status: 200 },
        );
      }

      expect(url.pathname).toBe('/api/v1/models');
      expect(request.headers.get('authorization')).toBeNull();
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'openai/account-visible',
              name: 'Account-visible GPT',
              context_length: 128_000,
              top_provider: { max_completion_tokens: 16_384 },
              pricing: { prompt: '0.000005', completion: '0.000015' },
              architecture: { modality: { input: ['text', 'image'], output: ['text'] } },
              supported_parameters: ['tools', 'response_format', 'reasoning'],
            },
            {
              id: 'anthropic/privacy-filtered',
              name: 'Must not become account membership',
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.mocked(globalThis.fetch).mockImplementation(server.fetch);

    const models = await createOpenRouterProvider().listModelsWithMetadata();

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'openai/account-visible',
      displayName: 'Account-visible GPT',
      contextLength: 65_536,
      maximumContextTokens: 65_536,
      maxOutputTokens: 16_384,
      maximumOutputTokens: 16_384,
      pricingInput: 5,
      pricingOutput: 15,
      supportsImages: true,
      supportsToolCalls: true,
      supportsStructuredOutput: true,
      supportsReasoning: true,
    });
    expect(models[0]?.capabilities).toEqual(
      expect.arrayContaining(['vision', 'tools', 'structured-output', 'reasoning']),
    );
    expect(models.map((model) => model.id)).not.toContain('anthropic/privacy-filtered');
  });

  it('does not consult the public catalog when only account membership IDs are requested', async () => {
    const server = fakeServer((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/models/user') {
        expect(request.headers.get('authorization')).toBe('Bearer sk-or-test-key');
        return new Response(JSON.stringify({ data: [{ id: 'openai/account-visible' }] }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected public catalog request: ${request.url}`);
    });
    vi.mocked(globalThis.fetch).mockImplementation(server.fetch);

    await expect(createOpenRouterProvider().listModels()).resolves.toEqual([
      'openai/account-visible',
    ]);
  });

  it.each([
    [
      'privacy restrictions',
      { error: { code: 'privacy_data_collection_restricted' } },
      'catalog-privacy-filtered',
    ],
    [
      'guardrail restrictions',
      { error: { code: 'guardrail_rejected' } },
      'catalog-guardrail-filtered',
    ],
    [
      'organization policy',
      { error: { code: 'organization_policy_denied' } },
      'catalog-policy-denied',
    ],
  ])('keeps %s distinct from an empty account catalog', async (_name, body, expectedError) => {
    const server = fakeServer((request) => {
      expect(new URL(request.url).pathname).toBe('/api/v1/models/user');
      expect(request.headers.get('authorization')).toBe('Bearer sk-or-test-key');
      return new Response(JSON.stringify(body), { status: 403 });
    });
    vi.mocked(globalThis.fetch).mockImplementation(server.fetch);

    const provider = createOpenRouterProvider();
    await expect(provider.listModels()).resolves.toEqual([]);
    expect(provider.getLastError?.()).toBe(expectedError);
  });

  it('treats a valid empty user catalog as empty without querying global metadata', async () => {
    const server = fakeServer((request) => {
      expect(new URL(request.url).pathname).toBe('/api/v1/models/user');
      expect(request.headers.get('authorization')).toBe('Bearer sk-or-test-key');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    vi.mocked(globalThis.fetch).mockImplementation(server.fetch);

    const provider = createOpenRouterProvider();
    await expect(provider.listModelsWithMetadata()).resolves.toEqual([]);
    expect(provider.getLastError?.()).toBeUndefined();
  });

  it('retains account membership when public enrichment fails and reports that partial outcome', async () => {
    const server = fakeServer((request) => {
      if (new URL(request.url).pathname === '/api/v1/models/user') {
        return new Response(JSON.stringify({ data: [{ id: 'openai/account-visible' }] }), {
          status: 200,
        });
      }
      expect(request.headers.get('authorization')).toBeNull();
      return new Response('unavailable', { status: 503 });
    });
    vi.mocked(globalThis.fetch).mockImplementation(server.fetch);

    const provider = createOpenRouterProvider();
    await expect(provider.listModelsWithMetadata()).resolves.toEqual([
      { id: 'openai/account-visible' },
    ]);
    expect(provider.getLastError?.()).toBe('global-catalog-unavailable: HTTP 503');
  });

  it('propagates caller cancellation to the account-filtered request', async () => {
    let requestSignal: AbortSignal | undefined;
    const server = fakeServer((request) => {
      requestSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(new DOMException('account request aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    vi.mocked(globalThis.fetch).mockImplementation(server.fetch);
    const controller = new AbortController();

    const pending = createOpenRouterProvider().listModels({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('does not send an account or public request when no OpenRouter API credential is selected', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const provider = createOpenRouterProvider();

    await expect(provider.listModelsWithMetadata()).resolves.toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
