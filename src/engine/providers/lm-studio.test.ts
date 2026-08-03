import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createLmStudioProvider } from './lm-studio.js';
import { DISCOVERY_HTTP_TIMEOUT_MS } from '../constants.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

type RequestRecord = Readonly<{
  method: string;
  pathname: string;
  authorization: string | undefined;
}>;

function recordRequest(input: RequestInfo | URL, init?: RequestInit): RequestRecord {
  const request = new Request(input, init);
  return {
    method: request.method,
    pathname: new URL(request.url).pathname,
    authorization: request.headers.get('authorization') ?? undefined,
  };
}

async function withLoopbackServer(
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    requests: RequestRecord[],
  ) => void,
  run: (input: Readonly<{ apiBase: string; requests: RequestRecord[] }>) => Promise<void>,
): Promise<void> {
  const requests: RequestRecord[] = [];
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      pathname: new URL(request.url ?? '/', 'http://loopback.invalid').pathname,
      authorization: request.headers.authorization,
    });
    handler(request, response, requests);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP LM Studio test server address.');
  }

  try {
    await run({ apiBase: `http://127.0.0.1:${address.port}/v1`, requests });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

describe('createLmStudioProvider native inventory', () => {
  it('preserves documented v1 false capability facts and reasoning options without treating reasoning default as a model default', async () => {
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/api/v1/models') {
          sendJson(response, 200, {
            models: [
              {
                key: 'deepseek/r1-q4',
                type: 'llm',
                display_name: 'DeepSeek R1 Q4',
                max_context_length: 131_072,
                capabilities: {
                  vision: false,
                  trained_for_tool_use: false,
                  reasoning: { allowed_options: ['off', 'on', 'high'], default: 'on' },
                },
                loaded_instances: [{ config: { context_length: 16_384 } }],
              },
            ],
          });
          return;
        }
        sendJson(response, 500, { unexpected: request.url });
      },
      async ({ apiBase, requests }) => {
        const models = await createLmStudioProvider({ apiBase }).listModelsWithMetadata();

        expect(models[0]?.nativeDefault).toBeUndefined();
        expect(models).toEqual([
          expect.objectContaining({
            id: 'deepseek/r1-q4',
            providerId: 'lm-studio',
            displayName: 'DeepSeek R1 Q4',
            maximumContextTokens: 131_072,
            effectiveContextTokens: 16_384,
            contextLength: 16_384,
            supportsImages: false,
            supportsToolCalls: false,
            supportsReasoning: true,
            nativeReasoningEfforts: ['off', 'on', 'high'],
            capabilities: expect.arrayContaining([
              'type:llm',
              'vision:false',
              'trained_for_tool_use:false',
              'reasoning:default:on',
              'loaded',
            ]),
          }),
        ]);
        expect(requests).toEqual([
          { method: 'GET', pathname: '/api/v1/models', authorization: undefined },
        ]);
      },
    );
  });

  it('does not reinterpret legacy capability arrays as documented v1 facts', async () => {
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/api/v1/models') {
          sendJson(response, 200, {
            models: [{ key: 'legacy-v0-row', type: 'llm', capabilities: ['vision'] }],
          });
          return;
        }
        sendJson(response, 500, { unexpected: request.url });
      },
      async ({ apiBase, requests }) => {
        expect(await createLmStudioProvider({ apiBase }).listModelsWithMetadata()).toEqual([]);
        expect(requests).toEqual([
          { method: 'GET', pathname: '/api/v1/models', authorization: undefined },
        ]);
      },
    );
  });

  it('rejects the legacy top-level data wrapper without falling back or reporting success', async () => {
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/api/v1/models') {
          sendJson(response, 200, {
            data: [{ key: 'legacy-data-row', type: 'llm' }],
          });
          return;
        }
        sendJson(response, 200, { data: [{ id: 'must-not-be-returned' }] });
      },
      async ({ apiBase, requests }) => {
        const provider = createLmStudioProvider({ apiBase });

        expect(await provider.listModelsWithMetadata()).toEqual([]);
        expect(provider.getLastError?.()).toBe('Invalid response payload');
        expect(requests.map((request) => request.pathname)).toEqual(['/api/v1/models']);
      },
    );
  });

  it('uses the native loopback inventory, preserves runtime facts, and excludes embeddings', async () => {
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/api/v1/models') {
          sendJson(response, 200, {
            models: [
              {
                key: 'acme/local-coder-q4',
                type: 'llm',
                display_name: 'Acme Local Coder Q4',
                max_context_length: 32_768,
                capabilities: { vision: true, trained_for_tool_use: true },
                loaded_instances: [{ context_length: 8_192 }],
              },
              {
                key: 'acme/embedder',
                type: 'embedding',
                display_name: 'Acme Embedder',
              },
            ],
          });
          return;
        }
        sendJson(response, 500, { unexpected: request.url });
      },
      async ({ apiBase, requests }) => {
        const provider = createLmStudioProvider({ apiBase });
        const models = await provider.listModelsWithMetadata();

        expect(models).toEqual([
          expect.objectContaining({
            id: 'acme/local-coder-q4',
            providerId: 'lm-studio',
            displayName: 'Acme Local Coder Q4',
            maximumContextTokens: 32_768,
            effectiveContextTokens: 8_192,
            contextLength: 8_192,
            supportsImages: true,
            supportsToolCalls: true,
            capabilities: expect.arrayContaining([
              'type:llm',
              'vision',
              'vision:true',
              'trained_for_tool_use',
              'trained_for_tool_use:true',
              'loaded',
            ]),
          }),
        ]);
        expect(requests).toEqual([
          {
            method: 'GET',
            pathname: '/api/v1/models',
            authorization: undefined,
          },
        ]);
      },
    );
  });

  it('sends an optional bearer token only to the validated literal loopback origin', async () => {
    const token = 'lm-studio-loopback-token';
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/api/v1/models') {
          sendJson(response, 200, { models: [{ key: 'secured-local', type: 'llm' }] });
          return;
        }
        sendJson(response, 500, { unexpected: request.url });
      },
      async ({ apiBase, requests }) => {
        const provider = createLmStudioProvider({ apiBase, apiKey: token });
        expect(await provider.listModels()).toEqual(['secured-local']);
        expect(requests).toEqual([
          {
            method: 'GET',
            pathname: '/api/v1/models',
            authorization: `Bearer ${token}`,
          },
        ]);
      },
    );
  });

  it('uses the compatibility inventory only after an explicitly unsupported native endpoint', async () => {
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/api/v1/models') {
          sendJson(response, 404, { error: 'native API unavailable' });
          return;
        }
        if (request.url === '/v1/models') {
          sendJson(response, 200, { data: [{ id: 'compatibility-visible-model' }] });
          return;
        }
        sendJson(response, 500, { unexpected: request.url });
      },
      async ({ apiBase, requests }) => {
        const provider = createLmStudioProvider({ apiBase });
        expect(await provider.listModelsWithMetadata()).toEqual([
          { id: 'compatibility-visible-model', providerId: 'lm-studio' },
        ]);
        expect(provider.getLastError?.()).toBeUndefined();
        expect(requests.map((request) => request.pathname)).toEqual([
          '/api/v1/models',
          '/v1/models',
        ]);
      },
    );
  });

  it.each([
    ['rejected authentication', 401, { error: 'unauthorized' }],
    ['malformed native payload', 200, { models: [{ id: 'not-a-native-row' }] }],
    ['valid empty native inventory', 200, { models: [] }],
  ])('does not fall back after %s', async (_case, status, payload) => {
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/api/v1/models') {
          sendJson(response, status, payload);
          return;
        }
        sendJson(response, 500, { unexpected: request.url });
      },
      async ({ apiBase, requests }) => {
        const provider = createLmStudioProvider({ apiBase });
        expect(await provider.listModels()).toEqual([]);
        expect(requests.map((request) => request.pathname)).toEqual(['/api/v1/models']);
      },
    );
  });

  it('rejects a same-origin redirect instead of following a local inventory redirect', async () => {
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/api/v1/models') {
          response.writeHead(307, { location: '/v1/models' });
          response.end();
          return;
        }
        sendJson(response, 200, { data: [{ id: 'must-not-be-requested' }] });
      },
      async ({ apiBase, requests }) => {
        const provider = createLmStudioProvider({ apiBase, apiKey: 'redirect-token' });
        expect(await provider.listModels()).toEqual([]);
        expect(requests.map((request) => request.pathname)).toEqual(['/api/v1/models']);
        expect(requests[0]?.authorization).toBe('Bearer redirect-token');
      },
    );
  });

  it('rejects LAN and wildcard endpoint overrides before a request can begin', () => {
    expect(() => createLmStudioProvider({ apiBase: 'http://192.168.1.20:1234/v1' })).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
    expect(() => createLmStudioProvider({ apiBase: 'http://0.0.0.0:1234/v1' })).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
  });
});

describe('createLmStudioProvider cancellation', () => {
  it('cancels an in-flight native inventory without trying the compatibility endpoint', async () => {
    const requestStarted = Promise.withResolvers<void>();
    const requestAborted = Promise.withResolvers<void>();
    const socketClosed = Promise.withResolvers<void>();
    await withLoopbackServer(
      (request, _response) => {
        if (request.url !== '/api/v1/models') return;
        request.once('aborted', () => requestAborted.resolve());
        request.socket.once('close', () => socketClosed.resolve());
        requestStarted.resolve();
      },
      async ({ apiBase, requests }) => {
        const controller = new AbortController();
        const pending = createLmStudioProvider({ apiBase }).listModels({
          signal: controller.signal,
        });
        await requestStarted.promise;
        controller.abort();

        await expect(pending).rejects.toThrow(/abort/i);
        await Promise.race([
          Promise.all([requestAborted.promise, socketClosed.promise]),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error('LM Studio request did not close after cancellation.')),
              1_000,
            );
          }),
        ]);
        expect(requests.map((request) => request.pathname)).toEqual(['/api/v1/models']);
      },
    );
  });
});

describe('createLmStudioProvider native timeout', () => {
  setupFetchMock();

  it('does not fall back after a native inventory times out', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const requests: RequestRecord[] = [];
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const request = recordRequest(input, init);
        requests.push(request);
        requestSignal = new Request(input, init).signal;
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('native inventory timed out', 'AbortError')),
            { once: true },
          );
        });
      });

      const pending = createLmStudioProvider().listModels();
      await vi.advanceTimersByTimeAsync(DISCOVERY_HTTP_TIMEOUT_MS + 1);

      expect(await pending).toEqual([]);
      expect(requestSignal?.aborted).toBe(true);
      expect(requests).toEqual([
        { method: 'GET', pathname: '/api/v1/models', authorization: undefined },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
