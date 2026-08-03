import { describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from './adapter.js';
import { setupEnvMock, setupFetchMock } from '#testing/helpers/fetch-mock.js';

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

describe('createAnthropicProvider account catalog', () => {
  setupFetchMock();
  setupEnvMock('ANTHROPIC_API_KEY', 'sk-ant-test-key');

  it('follows every cursor with required headers, deduplicates pages, and preserves limits and capabilities', async () => {
    const server = fakeServer((request) => {
      const url = new URL(request.url);
      expect(request.method).toBe('GET');
      expect(request.headers.get('x-api-key')).toBe('sk-ant-test-key');
      expect(request.headers.get('anthropic-version')).toBe('2023-06-01');
      expect(url.pathname).toBe('/v1/models');
      expect(url.searchParams.get('limit')).toBe('1000');

      if (url.searchParams.get('after_id') === null) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'claude-sonnet-account',
                display_name: 'Claude Sonnet Account',
                created_at: '2026-08-01T00:00:00Z',
                max_input_tokens: 1_000_000,
                max_output_tokens: 64_000,
                context_window: 1_000_000,
                capabilities: {
                  supports_images: true,
                  extended_thinking: { supported: true },
                  tool_use: true,
                  structured_outputs: true,
                  input_modalities: ['text', 'image'],
                  output_modalities: ['text'],
                },
              },
            ],
            has_more: true,
            last_id: 'cursor-one',
          }),
          { status: 200 },
        );
      }

      expect(url.searchParams.get('after_id')).toBe('cursor-one');
      return new Response(
        JSON.stringify({
          data: [
            { id: 'claude-sonnet-account' },
            {
              id: 'claude-opus-account',
              display_name: 'Claude Opus Account',
              max_input_tokens: 500_000,
              max_tokens: 32_000,
            },
          ],
          has_more: false,
        }),
        { status: 200 },
      );
    });
    vi.mocked(globalThis.fetch).mockImplementation(server.fetch);

    const models = await createAnthropicProvider().listModelsWithMetadata();

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'claude-sonnet-account',
      displayName: 'Claude Sonnet Account',
      releaseDate: '2026-08-01T00:00:00Z',
      contextLength: 1_000_000,
      maximumContextTokens: 1_000_000,
      maximumInputTokens: 1_000_000,
      maxOutputTokens: 64_000,
      maximumOutputTokens: 64_000,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      supportsImages: true,
      supportsReasoning: true,
      supportsToolCalls: true,
      supportsStructuredOutput: true,
    });
    expect(models[0]?.capabilities).toEqual(
      expect.arrayContaining(['vision', 'reasoning', 'tools', 'structured-output']),
    );
    expect(models[1]).toMatchObject({
      id: 'claude-opus-account',
      maximumInputTokens: 500_000,
      maxOutputTokens: 32_000,
      maximumOutputTokens: 32_000,
    });
    expect(
      server.requests.map((request) => new URL(request.url).searchParams.get('after_id')),
    ).toEqual([null, 'cursor-one']);
  });

  it('treats a valid empty account page as an empty catalog', async () => {
    const server = fakeServer((request) => {
      expect(new URL(request.url).searchParams.get('after_id')).toBeNull();
      return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
    });
    vi.mocked(globalThis.fetch).mockImplementation(server.fetch);

    const provider = createAnthropicProvider();
    await expect(provider.listModels()).resolves.toEqual([]);
    expect(provider.getLastError?.()).toBeUndefined();
  });

  it('keeps catalog failures separate from a valid empty response', async () => {
    const server = fakeServer(() => new Response('upstream failure', { status: 503 }));
    vi.mocked(globalThis.fetch).mockImplementation(server.fetch);

    const provider = createAnthropicProvider();
    await expect(provider.listModels()).resolves.toEqual([]);
    expect(provider.getLastError?.()).toBe('HTTP 503');
  });

  it('redacts a credential if the fetch boundary includes it in a failure', async () => {
    const credential = 'sk-ant-catalog-redaction-canary';
    const server = fakeServer(() => {
      throw new Error(`upstream repeated ${credential}`);
    });
    vi.mocked(globalThis.fetch).mockImplementation(server.fetch);

    const provider = createAnthropicProvider({ apiKey: credential });
    await expect(provider.listModels()).resolves.toEqual([]);
    expect(provider.getLastError?.()).not.toContain(credential);
    expect(provider.getLastError?.()).toContain('***REDACTED***');
  });

  it('marks malformed pagination responses as failures instead of returning a partial catalog', async () => {
    const server = fakeServer((request) => {
      if (new URL(request.url).searchParams.get('after_id') === null) {
        return new Response(
          JSON.stringify({ data: [{ id: 'first' }], has_more: true, last_id: 'cursor-one' }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ malformed: true }), { status: 200 });
    });
    vi.mocked(globalThis.fetch).mockImplementation(server.fetch);

    const provider = createAnthropicProvider();
    await expect(provider.listModels()).resolves.toEqual([]);
    expect(provider.getLastError?.()).toBe('Invalid response payload');
  });

  it('propagates caller cancellation to the live page request', async () => {
    let requestSignal: AbortSignal | undefined;
    const server = fakeServer((request) => {
      requestSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(new DOMException('catalog request aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    vi.mocked(globalThis.fetch).mockImplementation(server.fetch);
    const controller = new AbortController();

    const pending = createAnthropicProvider().listModels({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('does not send a request when no Anthropic API credential is selected', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const provider = createAnthropicProvider();

    await expect(provider.listModels()).resolves.toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
