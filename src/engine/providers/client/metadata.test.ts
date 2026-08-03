import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { z } from 'zod';
import { createMetadataProvider } from './metadata.js';
import { resolveProviderRunMetadata } from '../cost/breakdown.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

const REAL_HTTP_RELEASE_DEADLINE_MS = 1_000;

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
      authorization:
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined,
    });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP metadata provider test server address.');
  }

  try {
    await run({ apiBase: `http://127.0.0.1:${address.port}/v1`, requests });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function sendJson(response: http.ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function waitForPromptHttpRelease(
  requestAborted: Promise<void>,
  socketClosed: Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([requestAborted, socketClosed]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('Provider HTTP work did not release promptly after cancellation.')),
          REAL_HTTP_RELEASE_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('createMetadataProvider', () => {
  setupFetchMock();

  const RawSchema = z.object({ id: z.string(), context: z.number().optional() }).passthrough();
  type Raw = z.infer<typeof RawSchema>;

  const opts = {
    name: 'custom',
    defaultBaseURL: 'https://api.custom.com/v1',
    envKeyName: 'CUSTOM_API_KEY',
    isLocal: false,
    schema: RawSchema,
    fallback: (id: string): Raw => ({ id }),
    contextLength: (raw: Raw) => raw.context ?? null,
  };

  beforeEach(() => {
    delete process.env['CUSTOM_API_KEY'];
  });

  afterEach(() => {
    delete process.env['CUSTOM_API_KEY'];
  });

  it('listModels returns IDs on happy path', async () => {
    process.env['CUSTOM_API_KEY'] = 'key';
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b', context: 100 }] }), {
        status: 200,
      }),
    );
    const p = createMetadataProvider(opts);
    expect(await p.listModels()).toEqual(['a', 'b']);
  });

  it('returns [] when the built-in OpenAI extractor sees a non-canonical list shape', async () => {
    process.env['CUSTOM_API_KEY'] = 'key';
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ models: [{ id: 'a' }] }), { status: 200 }),
    );
    const p = createMetadataProvider(opts);
    expect(await p.listModels()).toEqual([]);
  });

  it('returns [] without contacting a non-local provider that has no API key', async () => {
    const requests: RequestRecord[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        method: request.method,
        pathname: new URL(request.url).pathname,
        authorization: request.headers.get('authorization') ?? undefined,
      });
      return new Response(JSON.stringify({ data: [{ id: 'unexpected' }] }), { status: 200 });
    });

    expect(await createMetadataProvider(opts).listModels()).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('fetches without auth when provider is local, regardless of API key', async () => {
    vi.unstubAllGlobals();
    await withLoopbackServer(
      (_request, response) => sendJson(response, { data: [{ id: 'x' }] }),
      async ({ apiBase, requests }) => {
        const localOpts = {
          ...opts,
          defaultBaseURL: apiBase,
          envKeyName: '',
          isLocal: true,
          endpointPolicy: { kind: 'loopback' as const, defaultBaseURL: apiBase },
        };

        expect(
          await createMetadataProvider(localOpts, { apiKey: 'must-not-send' }).listModels(),
        ).toEqual(['x']);
        expect(requests).toEqual([
          { method: 'GET', pathname: '/v1/models', authorization: undefined },
        ]);
      },
    );
  });

  it('sends an explicitly configured optional credential to a secured loopback inventory', async () => {
    const apiKey = 'local-optional-credential';
    vi.unstubAllGlobals();
    await withLoopbackServer(
      (_request, response) => sendJson(response, { data: [{ id: 'secured-local-model' }] }),
      async ({ apiBase, requests }) => {
        const loopbackOpts = {
          ...opts,
          defaultBaseURL: apiBase,
          envKeyName: '',
          isLocal: true,
          authentication: 'optional' as const,
          credentialSource: 'override-only' as const,
          endpointPolicy: { kind: 'loopback' as const, defaultBaseURL: apiBase },
        };

        expect(await createMetadataProvider(loopbackOpts, { apiKey }).listModels()).toEqual([
          'secured-local-model',
        ]);
        expect(requests).toEqual([
          { method: 'GET', pathname: '/v1/models', authorization: `Bearer ${apiKey}` },
        ]);
      },
    );
  });

  it('keeps an override-only local provider from borrowing an ambient credential', async () => {
    process.env.CUSTOM_API_KEY = 'ambient-cloud-credential';
    vi.unstubAllGlobals();
    await withLoopbackServer(
      (_request, response) => sendJson(response, { data: [{ id: 'local-model' }] }),
      async ({ apiBase, requests }) => {
        const loopbackOpts = {
          ...opts,
          defaultBaseURL: apiBase,
          isLocal: true,
          apiKeyDefault: 'local-sdk-placeholder',
          authentication: 'optional' as const,
          credentialSource: 'override-only' as const,
          endpointPolicy: { kind: 'loopback' as const, defaultBaseURL: apiBase },
        };

        const provider = createMetadataProvider(loopbackOpts);
        expect(provider.apiKey()).toBe('local-sdk-placeholder');
        expect(await provider.listModels()).toEqual(['local-model']);
        expect(requests).toEqual([
          { method: 'GET', pathname: '/v1/models', authorization: undefined },
        ]);
      },
    );
  });

  it('never transmits a credential from an explicitly unauthenticated local inventory', async () => {
    const apiKey = 'ollama-local-credential-must-not-leave-process';
    vi.unstubAllGlobals();
    await withLoopbackServer(
      (_request, response) => sendJson(response, { data: [{ id: 'local-model' }] }),
      async ({ apiBase, requests }) => {
        const localOpts = {
          ...opts,
          defaultBaseURL: apiBase,
          envKeyName: '',
          isLocal: true,
          authentication: 'none' as const,
          endpointPolicy: { kind: 'loopback' as const, defaultBaseURL: apiBase },
        };

        expect(await createMetadataProvider(localOpts, { apiKey }).listModels()).toEqual([
          'local-model',
        ]);
        expect(requests).toEqual([
          { method: 'GET', pathname: '/v1/models', authorization: undefined },
        ]);
      },
    );
  });

  it('rejects a redirect for a first-party loopback inventory without issuing a second request', async () => {
    vi.unstubAllGlobals();
    await withLoopbackServer(
      (_request, response) => {
        response.writeHead(307, { location: '/v1/models' });
        response.end();
      },
      async ({ apiBase, requests }) => {
        const loopbackOpts = {
          ...opts,
          defaultBaseURL: apiBase,
          envKeyName: '',
          isLocal: true,
          rejectRedirects: true,
          endpointPolicy: { kind: 'loopback' as const, defaultBaseURL: apiBase },
        };

        expect(await createMetadataProvider(loopbackOpts).listModels()).toEqual([]);
        expect(requests).toEqual([
          { method: 'GET', pathname: '/v1/models', authorization: undefined },
        ]);
      },
    );
  });

  it('honours overrides.apiBase and overrides.apiKey', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const p = createMetadataProvider(opts, {
      apiBase: 'https://override.example/v1',
      apiKey: 'override-key',
    });
    expect(p.baseURL).toBe('https://override.example/v1');
    expect(p.apiKey()).toBe('override-key');
  });

  it('normalizes a known provider endpoint before resolving an env credential', () => {
    expect(() =>
      createMetadataProvider(
        {
          ...opts,
          name: 'openai',
          defaultBaseURL: 'https://api.openai.com/v1',
        },
        { apiBase: 'https://lookalike.example/v1', apiKey: 'env:MISSING_ENDPOINT_KEY' },
      ),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
  });

  it('does not let a known provider replace its catalog endpoint policy', () => {
    expect(() =>
      createMetadataProvider(
        {
          ...opts,
          name: 'openai',
          defaultBaseURL: 'https://api.openai.com/v1',
          endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://candidate.example/v1' },
        },
        { apiBase: 'https://candidate.example/v1', apiKey: 'candidate-key' },
      ),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
  });

  it('accepts an explicit unregistered endpoint as its own fixed origin', () => {
    const p = createMetadataProvider(
      {
        ...opts,
        endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://candidate.example/v1' },
      },
      { apiBase: 'https://candidate.example/v1', apiKey: 'candidate-key' },
    );

    expect(p.baseURL).toBe('https://candidate.example/v1');
    expect(p.apiKey()).toBe('candidate-key');
  });

  it('uses custom modelsUrl when provided', async () => {
    vi.unstubAllGlobals();
    await withLoopbackServer(
      (_request, response) => sendJson(response, { data: [] }),
      async ({ apiBase, requests }) => {
        const provider = createMetadataProvider(
          {
            ...opts,
            defaultBaseURL: apiBase,
            envKeyName: '',
            endpointPolicy: { kind: 'loopback' as const, defaultBaseURL: apiBase },
            modelsUrl: (base) => `${base}/custom/models/path`,
          },
          { apiKey: 'k' },
        );

        expect(await provider.listModels()).toEqual([]);
        expect(requests).toEqual([
          { method: 'GET', pathname: '/v1/custom/models/path', authorization: 'Bearer k' },
        ]);
      },
    );
  });

  it('uses custom extractModels for non-OpenAI list shapes', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'qwen:7b' }, { name: 'llama:8b' }] }), {
        status: 200,
      }),
    );
    const p = createMetadataProvider({
      ...opts,
      isLocal: true,
      extractModels: (data: unknown): Raw[] | null => {
        if (typeof data !== 'object' || data === null) return null;
        const d = data as { models?: Array<{ name: string }> };
        if (!Array.isArray(d.models)) return null;
        return d.models.map((m) => ({ id: m.name }));
      },
    });
    expect(await p.listModels()).toEqual(['qwen:7b', 'llama:8b']);
  });

  it('falls back to opts.fallback for entries that fail schema parse', async () => {
    const StrictSchema = z.object({ id: z.string(), version: z.number() });
    type StrictRaw = z.infer<typeof StrictSchema>;

    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'ok-1', version: 1 }, { id: 'bad-1' }],
        }),
        { status: 200 },
      ),
    );

    let fallbackCount = 0;
    const p = createMetadataProvider<StrictRaw>({
      name: 'strict',
      defaultBaseURL: 'https://api.strict/v1',
      envKeyName: 'STRICT_API_KEY',
      isLocal: true,
      schema: StrictSchema,
      fallback: (id): StrictRaw => {
        fallbackCount += 1;
        return { id, version: 0 };
      },
    });

    expect(await p.listModels()).toEqual(['ok-1', 'bad-1']);
    expect(fallbackCount).toBe(1);
  });

  it('getLastError exposes last fetchModelList error and clears on success', async () => {
    process.env['CUSTOM_API_KEY'] = 'key';
    const p = createMetadataProvider(opts);
    expect(p.getLastError?.()).toBeUndefined();

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('bad', { status: 500 }));
    await p.listModels();
    expect(p.getLastError?.()).toBe('HTTP 500');

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'a' }] }), { status: 200 }),
    );
    await p.listModels();
    expect(p.getLastError?.()).toBeUndefined();
  });

  it('persists only redacted provider diagnostics after a credentialed request fails', async () => {
    const canary = 'canary-metadata-credential-1b8e';
    process.env['CUSTOM_API_KEY'] = canary;
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new Error(`provider response included Authorization: Bearer ${canary}`),
    );

    const p = createMetadataProvider(opts);
    await p.listModels();

    const diagnostic = p.getLastError?.() ?? '';
    expect(diagnostic).not.toContain(canary);
    expect(diagnostic).toContain('***REDACTED***');
  });

  it('raises a typed, redacted error when header construction fails', async () => {
    const canary = 'canary-metadata-header-credential-7c2a';
    const headerFailure = new Error(`header callback saw Authorization: Bearer ${canary}`);
    const headerOpts = {
      ...opts,
      headers: () => {
        throw headerFailure;
      },
    };
    const p = createMetadataProvider(headerOpts, { apiKey: canary });

    await expect(p.listModels()).rejects.toMatchObject({
      kind: 'provider-header-callback-failed',
      message: expect.stringContaining('***REDACTED***'),
      data: {
        provider: 'custom',
        diagnostic: expect.stringContaining('***REDACTED***'),
      },
    });
    expect(p.getLastError?.()).toContain('***REDACTED***');
    expect(p.getLastError?.()).not.toContain(canary);
  });

  it('detectContextLength returns mapped context for matching model, null otherwise', async () => {
    process.env['CUSTOM_API_KEY'] = 'key';
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'alpha', context: 32768 }, { id: 'beta' }],
        }),
        { status: 200 },
      ),
    );
    const p = createMetadataProvider(opts);
    expect(await p.detectContextLength('alpha')).toBe(32768);
    expect(await p.detectContextLength('beta')).toBeNull();
    expect(await p.detectContextLength('missing')).toBeNull();
  });

  it('listModelsWithMetadata applies custom toDetected mapper', async () => {
    process.env['CUSTOM_API_KEY'] = 'key';
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'a', context: 50 }] }), { status: 200 }),
    );
    const p = createMetadataProvider({
      ...opts,
      toDetected: (raw) => {
        const base = { id: raw.id, pricingInput: 1 };
        return raw.context !== undefined ? { ...base, contextLength: raw.context } : base;
      },
    });
    const detected = await p.listModelsWithMetadata();
    expect(detected).toEqual([{ id: 'a', contextLength: 50, pricingInput: 1 }]);
  });
});

describe('metadata provider cancellation', () => {
  it.each([
    'model IDs',
    'model metadata',
  ] as const)('aborts real local HTTP work for %s promptly without returning a late result', async (method) => {
    const requestStarted = Promise.withResolvers<void>();
    const requestAborted = Promise.withResolvers<void>();
    const socketClosed = Promise.withResolvers<void>();
    const server = http.createServer((request) => {
      request.once('aborted', () => requestAborted.resolve());
      request.socket.once('close', () => socketClosed.resolve());
      requestStarted.resolve();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP provider test server address.');
    }
    const baseURL = `http://127.0.0.1:${address.port}/v1`;

    try {
      const provider = createMetadataProvider({
        name: 'local-cancellation',
        defaultBaseURL: baseURL,
        envKeyName: '',
        isLocal: true,
        schema: z.object({ id: z.string() }),
        fallback: (id) => ({ id }),
        endpointPolicy: { kind: 'loopback', defaultBaseURL: baseURL },
      });
      const controller = new AbortController();
      const pending =
        method === 'model IDs'
          ? provider.listModels({ signal: controller.signal })
          : provider.listModelsWithMetadata({ signal: controller.signal });
      let published = false;
      void pending.then(
        () => {
          published = true;
        },
        () => undefined,
      );

      await requestStarted.promise;
      const abortedAt = Date.now();
      controller.abort();

      await expect(pending).rejects.toThrow(/abort/i);
      await waitForPromptHttpRelease(requestAborted.promise, socketClosed.promise);
      expect(Date.now() - abortedAt).toBeLessThan(REAL_HTTP_RELEASE_DEADLINE_MS);
      expect(published).toBe(false);
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('metadata provider offering billing metadata', () => {
  setupFetchMock();

  const RawSchema = z.object({ id: z.string(), context: z.number().optional() }).passthrough();
  type Raw = z.infer<typeof RawSchema>;

  it('carries catalog service, offering, billing, and asOf from a metadata provider base URL', () => {
    const p = createMetadataProvider<Raw>({
      name: 'deepseek',
      defaultBaseURL: 'https://api.deepseek.com/v1',
      envKeyName: 'DEEPSEEK_API_KEY',
      isLocal: false,
      schema: RawSchema,
      fallback: (id): Raw => ({ id }),
    });

    expect(resolveProviderRunMetadata({ tool: p.name, normalizedEndpoint: p.baseURL })).toEqual({
      service: 'deepseek',
      offering: 'payg',
      normalizedEndpoint: 'https://api.deepseek.com/v1',
      billing: 'api-metered',
      asOf: '2026-07-31',
    });
  });

  it('retains normalized endpoint overrides in run metadata', () => {
    const p = createMetadataProvider<Raw>(
      {
        name: 'openai',
        defaultBaseURL: 'https://api.openai.com/v1',
        envKeyName: 'OPENAI_API_KEY',
        isLocal: false,
        schema: RawSchema,
        fallback: (id): Raw => ({ id }),
      },
      { apiBase: 'https://api.openai.com/v1' },
    );

    expect(
      resolveProviderRunMetadata({ tool: p.name, normalizedEndpoint: p.baseURL }),
    ).toMatchObject({
      service: 'openai',
      offering: 'payg',
      normalizedEndpoint: 'https://api.openai.com/v1',
      billing: 'api-metered',
      asOf: '2026-07-31',
    });
  });

  it('labels local metadata providers as local compute in run metadata', () => {
    const p = createMetadataProvider<Raw>({
      name: 'ollama',
      defaultBaseURL: 'http://localhost:11434/v1',
      envKeyName: 'OLLAMA_API_KEY',
      isLocal: true,
      schema: RawSchema,
      fallback: (id): Raw => ({ id }),
    });

    expect(resolveProviderRunMetadata({ tool: p.name, normalizedEndpoint: p.baseURL })).toEqual({
      service: 'ollama',
      offering: 'local',
      normalizedEndpoint: 'http://localhost:11434/v1',
      billing: 'local',
      asOf: '2026-07-31',
    });
  });
});
