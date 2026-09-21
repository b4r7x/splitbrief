import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createLlamaCppProvider } from './llama-cpp.js';
import { detectProviderCatalog } from './catalog-detection.js';
import { DetectedModelSchema } from '../../core/discovery/detection.js';

/**
 * Fixtures follow the llama.cpp server contract as documented for the supported
 * server revision reviewed on 2026-09-16: `GET /v1/models` is the OpenAI-shaped
 * inventory (single model or router), its per-entry `meta` is optional, and
 * `GET /health` answers `200 {"status":"ok"}` or `503` while a model loads
 * without checking an API key.
 * https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#api-endpoints
 */

type RequestRecord = Readonly<{
  method: string;
  pathname: string;
  authorization: string | undefined;
}>;

async function withLoopbackServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
  run: (input: Readonly<{ apiBase: string; requests: RequestRecord[] }>) => Promise<void>,
): Promise<void> {
  const requests: RequestRecord[] = [];
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      pathname: new URL(request.url ?? '/', 'http://loopback.invalid').pathname,
      authorization: request.headers.authorization,
    });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP llama.cpp test server address.');
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

function modelList(data: readonly unknown[]): unknown {
  return { object: 'list', data };
}

describe('createLlamaCppProvider inventory', () => {
  it('preserves the exact single-model alias and its trained context ceiling', async () => {
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/v1/models') {
          sendJson(
            response,
            200,
            modelList([
              {
                id: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
                object: 'model',
                created: 1_757_000_000,
                owned_by: 'llamacpp',
                meta: { n_ctx_train: 32_768, n_params: 7_615_616_512 },
              },
            ]),
          );
          return;
        }
        sendJson(response, 500, { unexpected: request.url });
      },
      async ({ apiBase, requests }) => {
        const models = await createLlamaCppProvider({ apiBase }).listModelsWithMetadata();

        expect(models).toEqual([
          expect.objectContaining({
            id: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
            providerId: 'llama-cpp',
            maximumContextTokens: 32_768,
            contextLength: 32_768,
          }),
        ]);
        expect(models[0]?.runtime?.loadState).toBe('unknown');
        expect(DetectedModelSchema.safeParse(models[0]).success).toBe(true);
        expect(requests.map((entry) => entry.pathname)).toEqual(['/v1/models']);
        expect(requests[0]?.authorization).toBeUndefined();
      },
    );
  });

  it('preserves every router model id and leaves absent metadata unknown', async () => {
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/v1/models') {
          sendJson(
            response,
            200,
            modelList([
              { id: 'qwen3-coder-30b', object: 'model', owned_by: 'llamacpp' },
              { id: 'qwen3-coder-30b:q8', object: 'model', owned_by: 'llamacpp' },
              {
                id: 'gemma-3-12b',
                object: 'model',
                owned_by: 'llamacpp',
                meta: { n_ctx_train: 8_192 },
              },
            ]),
          );
          return;
        }
        sendJson(response, 500, { unexpected: request.url });
      },
      async ({ apiBase }) => {
        const provider = createLlamaCppProvider({ apiBase });
        const models = await provider.listModelsWithMetadata();

        expect(models.map((model) => model.id)).toEqual([
          'qwen3-coder-30b',
          'qwen3-coder-30b:q8',
          'gemma-3-12b',
        ]);
        expect(models[0]?.maximumContextTokens).toBeUndefined();
        expect(models[0]?.contextLength).toBeUndefined();
        expect(models[0]?.runtime?.loadState).toBe('unknown');
        expect(await provider.detectContextLength('qwen3-coder-30b')).toBeNull();
        expect(await provider.detectContextLength('gemma-3-12b')).toBe(8_192);
        expect(typeof provider.getLastError).toBe('function');
        expect(provider.getLastError?.()).toBeUndefined();
      },
    );
  });

  it('sends an explicitly configured credential and nothing when none is configured', async () => {
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/v1/models') {
          sendJson(response, 200, modelList([{ id: 'local-model' }]));
          return;
        }
        sendJson(response, 500, { unexpected: request.url });
      },
      async ({ apiBase, requests }) => {
        await createLlamaCppProvider({ apiBase }).listModels();
        await createLlamaCppProvider({ apiBase, apiKey: 'llama-secret' }).listModels();

        expect(requests.map((entry) => entry.authorization)).toEqual([
          undefined,
          'Bearer llama-secret',
        ]);
      },
    );
  });
});

describe('createLlamaCppProvider readiness facts', () => {
  it('keeps a rejected catalog unauthorized even when public /health answers', async () => {
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/health') {
          sendJson(response, 200, { status: 'ok' });
          return;
        }
        sendJson(response, 401, { error: { message: 'invalid api key' } });
      },
      async ({ apiBase, requests }) => {
        const provider = createLlamaCppProvider({ apiBase });

        expect(await provider.listModels()).toEqual([]);
        expect(provider.getLastError?.()).toBe('HTTP 401');
        expect(requests.map((entry) => entry.pathname)).toEqual(['/v1/models']);

        const outcome = await detectProviderCatalog({
          provider: 'llama-cpp',
          configOverrides: { apiBase },
        });
        expect(outcome).toMatchObject({ kind: 'failed', failure: 'invalid-credential' });
      },
    );
  });

  it('keeps a forbidden catalog policy-denied without consulting /health', async () => {
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/health') {
          sendJson(response, 200, { status: 'ok' });
          return;
        }
        sendJson(response, 403, { error: { message: 'forbidden' } });
      },
      async ({ apiBase, requests }) => {
        const provider = createLlamaCppProvider({ apiBase });

        expect(await provider.listModels()).toEqual([]);
        expect(provider.getLastError?.()).toBe('HTTP 403');
        expect(requests.map((entry) => entry.pathname)).toEqual(['/v1/models']);
      },
    );
  });

  it('names a cold start from the read-only /health answer', async () => {
    await withLoopbackServer(
      (request, response) => {
        if (request.url === '/health') {
          sendJson(response, 503, { error: { message: 'Loading model' } });
          return;
        }
        sendJson(response, 503, { error: { message: 'Loading model' } });
      },
      async ({ apiBase, requests }) => {
        const provider = createLlamaCppProvider({ apiBase });

        expect(await provider.listModels()).toEqual([]);
        expect(provider.getLastError?.()).toBe('HTTP 503 (/health: loading model)');
        expect(requests.map((entry) => entry)).toEqual([
          expect.objectContaining({ method: 'GET', pathname: '/v1/models' }),
          expect.objectContaining({ method: 'GET', pathname: '/health' }),
        ]);
      },
    );
  });

  it('leaves a malformed catalog payload malformed', async () => {
    await withLoopbackServer(
      (_request, response) => {
        sendJson(response, 200, { models: ['not-an-openai-list'] });
      },
      async ({ apiBase, requests }) => {
        const provider = createLlamaCppProvider({ apiBase });

        expect(await provider.listModels()).toEqual([]);
        expect(provider.getLastError?.()).toBe('Invalid response payload');
        expect(requests.map((entry) => entry.pathname)).toEqual(['/v1/models']);
      },
    );
  });

  it('refuses a redirected inventory instead of following it', async () => {
    await withLoopbackServer(
      (_request, response) => {
        response.writeHead(302, { location: 'https://models.example.test/v1/models' });
        response.end();
      },
      async ({ apiBase }) => {
        const provider = createLlamaCppProvider({ apiBase });

        expect(await provider.listModels()).toEqual([]);
        expect(provider.getLastError?.()).toContain('endpoint policy');
      },
    );
  });
});

describe('createLlamaCppProvider endpoint policy', () => {
  it('rejects a LAN address and keeps the loopback default', () => {
    expect(() => createLlamaCppProvider({ apiBase: 'http://192.168.1.10:8080/v1' })).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
    expect(() => createLlamaCppProvider({ apiBase: 'https://llama.example.test/v1' })).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
    expect(createLlamaCppProvider().baseURL).toBe('http://localhost:8080/v1');
  });
});
