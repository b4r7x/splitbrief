import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_PROVIDER_CATALOG } from '../../core/providers/api-provider-catalog.js';
import { createOllamaCloudProvider, createOllamaProvider } from './ollama.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

type RequestRecord = Readonly<{
  method: string;
  pathname: string;
  authorization: string | undefined;
}>;

async function withLoopbackOllama(
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
    throw new Error('Expected a TCP Ollama test server address.');
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

describe('createOllamaProvider native inventory', () => {
  afterEach(() => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_LOCAL_API_KEY;
  });

  it('uses exact local tags, retains native detail facts, never sends the cloud key, and lazily fetches detail', async () => {
    const cloudKeyCanary = 'cloud-key-must-never-reach-local-daemon';
    process.env.OLLAMA_API_KEY = cloudKeyCanary;
    await withLoopbackOllama(
      (request, response) => {
        if (request.url === '/api/tags') {
          sendJson(response, 200, {
            models: [
              {
                name: 'acme/coder:latest',
                details: {
                  family: 'llama',
                  parameter_size: '7B',
                  quantization_level: 'Q4_K_M',
                },
              },
              { name: 'acme/coder:cloud' },
            ],
          });
          return;
        }
        if (request.url === '/api/show' && request.method === 'POST') {
          sendJson(response, 200, { parameters: 'num_ctx 32768\ntemperature 0.7' });
          return;
        }
        sendJson(response, 500, { unexpected: request.url });
      },
      async ({ apiBase, requests }) => {
        const provider = createOllamaProvider({ apiBase });
        expect(provider.apiKey()).toBe('ollama');
        expect(await provider.listModelsWithMetadata()).toEqual([
          expect.objectContaining({
            id: 'acme/coder:latest',
            providerId: 'ollama',
            capabilities: ['family:llama', 'parameters:7B', 'quantization:Q4_K_M'],
          }),
          expect.objectContaining({
            id: 'acme/coder:cloud',
            providerId: 'ollama',
            capabilities: ['remote-backed'],
          }),
        ]);
        expect(requests).toEqual([
          { method: 'GET', pathname: '/api/tags', authorization: undefined },
        ]);

        expect(await provider.detectContextLength('acme/coder:latest')).toBe(32_768);
        expect(requests).toEqual([
          { method: 'GET', pathname: '/api/tags', authorization: undefined },
          { method: 'POST', pathname: '/api/show', authorization: undefined },
        ]);
        expect(JSON.stringify(requests)).not.toContain(cloudKeyCanary);
      },
    );
  });

  it('sends an explicitly configured local credential only to the literal loopback daemon', async () => {
    const localCredential = 'local-ollama-token';
    process.env.OLLAMA_LOCAL_API_KEY = localCredential;
    await withLoopbackOllama(
      (request, response) => {
        if (request.url === '/api/tags') {
          sendJson(response, 200, { models: [{ name: 'secured-local-model' }] });
          return;
        }
        if (request.url === '/api/show' && request.method === 'POST') {
          sendJson(response, 200, { parameters: 'num_ctx 8192' });
          return;
        }
        sendJson(response, 500, { unexpected: request.url });
      },
      async ({ apiBase, requests }) => {
        const provider = createOllamaProvider({
          apiBase,
          apiKey: 'env:OLLAMA_LOCAL_API_KEY',
        });
        expect(provider.apiKey()).toBe(localCredential);
        expect(await provider.listModels()).toEqual(['secured-local-model']);
        expect(await provider.detectContextLength('secured-local-model')).toBe(8192);
        expect(requests).toEqual([
          {
            method: 'GET',
            pathname: '/api/tags',
            authorization: `Bearer ${localCredential}`,
          },
          {
            method: 'POST',
            pathname: '/api/show',
            authorization: `Bearer ${localCredential}`,
          },
        ]);
      },
    );
  });

  it.each([
    'inline-local-secret',
    'env:ARBITRARY_LOCAL_KEY',
    'env:OLLAMA_API_KEY',
  ])('rejects %s before a local factory can resolve or send a cloud credential', async (apiKey) => {
    const cloudKeyCanary = 'cloud-key-must-not-reach-loopback';
    process.env.OLLAMA_API_KEY = cloudKeyCanary;
    await withLoopbackOllama(
      (_request, response) => sendJson(response, 500, { unexpected: 'request' }),
      async ({ apiBase, requests }) => {
        expect(() => createOllamaProvider({ apiBase, apiKey })).toThrow(
          expect.objectContaining({ kind: 'provider-ollama-local-credential-invalid' }),
        );
        expect(requests).toEqual([]);
        expect(JSON.stringify(requests)).not.toContain(cloudKeyCanary);
      },
    );
  });

  it('treats a valid empty tag inventory as empty rather than inventing a bundled model', async () => {
    await withLoopbackOllama(
      (request, response) => {
        if (request.url === '/api/tags') {
          sendJson(response, 200, { models: [] });
          return;
        }
        sendJson(response, 500, { unexpected: request.url });
      },
      async ({ apiBase, requests }) => {
        const provider = createOllamaProvider({ apiBase });
        expect(await provider.listModels()).toEqual([]);
        expect(requests).toEqual([
          { method: 'GET', pathname: '/api/tags', authorization: undefined },
        ]);
      },
    );
  });

  it('rejects a local inventory redirect before the target receives a request', async () => {
    await withLoopbackOllama(
      (request, response) => {
        if (request.url === '/api/tags') {
          response.writeHead(307, { location: '/v1/models' });
          response.end();
          return;
        }
        sendJson(response, 200, { data: [{ id: 'must-not-be-requested' }] });
      },
      async ({ apiBase, requests }) => {
        expect(await createOllamaProvider({ apiBase }).listModels()).toEqual([]);
        expect(requests).toEqual([
          { method: 'GET', pathname: '/api/tags', authorization: undefined },
        ]);
      },
    );
  });
});

describe('createOllamaCloudProvider', () => {
  setupFetchMock();

  afterEach(() => {
    delete process.env.OLLAMA_API_KEY;
  });

  it('is a distinct remote provider that sends the cloud key only to the fixed Ollama origin', async () => {
    const cloudKey = 'ollama-cloud-key';
    process.env.OLLAMA_API_KEY = cloudKey;
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'cloud-model' }] }), { status: 200 }),
    );

    const provider = createOllamaCloudProvider();
    const endpointPolicy = API_PROVIDER_CATALOG['ollama-cloud'].endpointPolicy;
    if (endpointPolicy.kind !== 'fixed-origin') {
      throw new Error('Expected the active Ollama Cloud descriptor to use a fixed origin.');
    }
    expect(provider.name).toBe('ollama-cloud');
    expect(provider.isLocal).toBe(false);
    expect(provider.baseURL).toBe(endpointPolicy.baseURL);
    expect(await provider.listModelsWithMetadata()).toEqual([
      { id: 'cloud-model', providerId: 'ollama-cloud' },
    ]);

    const request = new Request(
      vi.mocked(globalThis.fetch).mock.calls[0]?.[0] ?? '',
      vi.mocked(globalThis.fetch).mock.calls[0]?.[1],
    );
    expect(request.url).toBe(`${endpointPolicy.baseURL}/api/tags`);
    expect(request.headers.get('authorization')).toBe(`Bearer ${cloudKey}`);
  });

  it('does not infer direct-cloud readiness from key presence and rejects alternate origins', async () => {
    expect(await createOllamaCloudProvider().listModels()).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(() =>
      createOllamaCloudProvider({
        apiBase: 'https://lookalike.ollama.com',
        apiKey: 'env:OLLAMA_CLOUD_NEVER_RESOLVE',
      }),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
  });
});
