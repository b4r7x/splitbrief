import { describe, expect, it, vi } from 'vitest';
import { createTogetherProvider } from './together.js';
import { setupEnvMock, setupFetchMock } from '#testing/helpers/fetch-mock.js';

type RequestRecord = Readonly<{
  method: string;
  url: string;
  authorization: string | undefined;
}>;

function recordRequest(input: RequestInfo | URL, init?: RequestInit): RequestRecord {
  const request = new Request(input, init);
  return {
    method: request.method,
    url: request.url,
    authorization: request.headers.get('authorization') ?? undefined,
  };
}

describe('createTogetherProvider', () => {
  setupFetchMock();
  setupEnvMock('TOGETHER_API_KEY', 'test-key');

  it('uses only the current official origin', () => {
    expect(createTogetherProvider().baseURL).toBe('https://api.together.ai/v1');
    expect(() => createTogetherProvider({ apiBase: 'https://api.together.xyz/v1' })).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
  });

  it('reads the documented top-level array and preserves per-million pricing', async () => {
    const requests: RequestRecord[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(recordRequest(input, init));
      return new Response(
        JSON.stringify([
          {
            id: 'meta-llama/Llama-3-70b-chat-hf',
            type: 'chat',
            serverless: true,
            display_name: 'Llama 3 70B Chat',
            context_length: 8192,
            pricing: { input: 0.9, output: 1.1 },
          },
        ]),
        { status: 200 },
      );
    });

    const models = await createTogetherProvider().listModelsWithMetadata();

    expect(models).toEqual([
      {
        id: 'meta-llama/Llama-3-70b-chat-hf',
        displayName: 'Llama 3 70B Chat',
        contextLength: 8192,
        pricingInput: 0.9,
        pricingOutput: 1.1,
        isFree: false,
      },
    ]);
    expect(requests).toEqual([
      {
        method: 'GET',
        url: 'https://api.together.ai/v1/models',
        authorization: 'Bearer test-key',
      },
    ]);
  });

  it('retains only generative rows with affirmative serverless deployment evidence', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: 'chat', type: 'chat', serverless: true },
          { id: 'language', type: 'language', deployment: 'serverless' },
          {
            id: 'private/acme-code',
            type: 'code',
            deployment_type: 'serverless',
          },
          { id: 'ambiguous', type: 'chat' },
          { id: 'image', type: 'image' },
          { id: 'embedding', type: 'embedding' },
          { id: 'moderation', type: 'moderation' },
          { id: 'rerank', type: 'rerank' },
          { id: 'dedicated-type', type: 'dedicated' },
          { id: 'dedicated-deployment', type: 'chat', deployment: 'dedicated' },
          { id: 'dedicated-only', type: 'chat', dedicated_only: true },
          { id: 'not-serverless', type: 'chat', serverless: false },
          { id: 'conflicting-deployment', type: 'chat', serverless: true, deployment: 'dedicated' },
        ]),
        { status: 200 },
      ),
    );

    expect(await createTogetherProvider().listModels()).toEqual([
      'chat',
      'language',
      'private/acme-code',
    ]);
  });

  it('does not infer free use from a partial price declaration', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: 'partial-price', type: 'language', serverless: true, pricing: { input: 0 } },
        ]),
        { status: 200 },
      ),
    );

    expect(await createTogetherProvider().listModelsWithMetadata()).toEqual([
      { id: 'partial-price', pricingInput: 0 },
    ]);
  });

  it('does not accept the former OpenAI-shaped wrapper as an authoritative model list', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'chat', type: 'chat', serverless: true }] }), {
        status: 200,
      }),
    );

    const provider = createTogetherProvider();
    expect(await provider.listModels()).toEqual([]);
    expect(provider.getLastError?.()).toBe('Invalid response payload');
  });

  it('does not forward credentials across a cross-origin redirect', async () => {
    const requests: RequestRecord[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(recordRequest(input, init));
      return new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example.test/collect' },
      });
    });

    const provider = createTogetherProvider();
    expect(await provider.listModels()).toEqual([]);
    expect(requests).toEqual([
      {
        method: 'GET',
        url: 'https://api.together.ai/v1/models',
        authorization: 'Bearer test-key',
      },
    ]);
  });
});
