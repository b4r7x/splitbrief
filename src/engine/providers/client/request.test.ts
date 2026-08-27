import http from 'node:http';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { endpointPolicyFetch } from '../../../core/providers/endpoint-policy.js';
import { createProviderConnection } from './connection.js';
import { fetchJsonWithTimeout, fetchModelList } from './request.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

const fixedOriginPolicy = {
  kind: 'fixed-origin' as const,
  baseURL: 'https://api.example.com/v1',
};

const attackerOrigin = 'https://evil.example.net';

type RequestRecord = Readonly<{
  method: string;
  url: string;
  authorization: string | undefined;
  apiKey: string | undefined;
}>;

function recordRequest(input: RequestInfo | URL, init?: RequestInit): RequestRecord {
  const request = new Request(input, init);
  return {
    method: request.method,
    url: request.url,
    authorization: request.headers.get('authorization') ?? undefined,
    apiKey: request.headers.get('x-api-key') ?? undefined,
  };
}

function assertZeroAttackerHostCredentialObservations(requests: readonly RequestRecord[]): void {
  for (const request of requests) {
    const origin = new URL(request.url).origin;
    expect(origin).not.toBe(attackerOrigin);
  }
}

async function withLoopbackServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
  run: (input: Readonly<{ endpoint: string; requests: RequestRecord[] }>) => Promise<void>,
): Promise<void> {
  const requests: RequestRecord[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://loopback.invalid');
    requests.push({
      method: request.method ?? '',
      url: url.href,
      authorization:
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined,
      apiKey:
        typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined,
    });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP request test server address.');
  }

  try {
    await run({ endpoint: `http://127.0.0.1:${address.port}/v1/models`, requests });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('fetchJsonWithTimeout', () => {
  setupFetchMock();

  it('returns parsed JSON on 2xx', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ hello: 'world' }), { status: 200 }),
    );
    const result = await fetchJsonWithTimeout({
      url: 'https://api.example.com/v1',
      timeoutMs: 1000,
    });
    expect(result).toEqual({ hello: 'world' });
  });

  it('throws on non-ok status with HTTP code in message', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('err', { status: 503 }));
    await expect(
      fetchJsonWithTimeout({ url: 'https://api.example.com/v1', timeoutMs: 1000 }),
    ).rejects.toThrow('HTTP 503');
  });

  it('aborts with a AbortError when the timeout fires before response', async () => {
    let signalRef: AbortSignal | undefined;
    vi.mocked(globalThis.fetch).mockImplementationOnce((_url, init) => {
      signalRef = (init as RequestInit | undefined)?.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        signalRef?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    await expect(
      fetchJsonWithTimeout({ url: 'https://slow.example.com', timeoutMs: 5 }),
    ).rejects.toThrow(/abort|timeout/i);
    expect(signalRef?.aborted).toBe(true);
  });

  it('combines a caller cancellation signal with the timeout signal', async () => {
    const controller = new AbortController();
    let signalRef: AbortSignal | undefined;
    vi.mocked(globalThis.fetch).mockImplementationOnce((_url, init) => {
      signalRef = (init as RequestInit | undefined)?.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        signalRef?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    const pending = fetchJsonWithTimeout({
      url: 'https://slow.example.com',
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(signalRef?.aborted).toBe(true);
  });
});

describe('fetchModelList', () => {
  setupFetchMock();

  const defaultExtract = (data: unknown): Array<{ id: string }> | null => {
    if (typeof data !== 'object' || data === null) return null;
    const list = (data as { data?: unknown }).data;
    if (!Array.isArray(list)) return null;
    return list.map((entry) => ({ id: (entry as { id: string }).id }));
  };

  it('returns extracted models on 200 + valid payload and clears error on onError', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }), { status: 200 }),
    );
    const errors: Array<string | undefined> = [];
    const result = await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      apiKey: 'k',
      onError: (err: string | undefined) => errors.push(err),
      extractModels: defaultExtract,
    });
    expect(result).toEqual([{ id: 'm1' }, { id: 'm2' }]);
    expect(errors.at(-1)).toBeUndefined();
  });

  it('passes an AbortSignal to fetch and aborts when the request stalls past the timeout', async () => {
    vi.useFakeTimers();
    try {
      let signalRef: AbortSignal | undefined;
      vi.mocked(globalThis.fetch).mockImplementationOnce((_url, init) => {
        signalRef = (init as RequestInit | undefined)?.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signalRef?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      });

      const errors: Array<string | undefined> = [];
      const pending = fetchModelList({
        endpoint: 'https://slow.example.com/v1/models',
        onError: (err: string | undefined) => errors.push(err),
        extractModels: defaultExtract,
      });

      await vi.advanceTimersByTimeAsync(6_000);
      const result = await pending;

      expect(signalRef).toBeInstanceOf(AbortSignal);
      expect(signalRef?.aborted).toBe(true);
      expect(result).toEqual([]);
      expect(errors.some((e) => /abort|timeout/i.test(e ?? ''))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses custom headers verbatim when provided (no Authorization injection)', async () => {
    vi.unstubAllGlobals();
    await withLoopbackServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [] }));
      },
      async ({ endpoint, requests }) => {
        expect(
          await fetchModelList({
            endpoint,
            apiKey: 'should-be-ignored',
            headers: { 'x-api-key': 'custom' },
            extractModels: defaultExtract,
          }),
        ).toEqual([]);
        expect(requests).toEqual([
          {
            method: 'GET',
            url: 'http://loopback.invalid/v1/models',
            authorization: undefined,
            apiKey: 'custom',
          },
        ]);
      },
    );
  });

  it('returns [] on non-ok and reports HTTP status via onError', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('bad', { status: 401 }));
    const errors: Array<string | undefined> = [];
    const result = await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      onError: (err: string | undefined) => errors.push(err),
      extractModels: defaultExtract,
    });
    expect(result).toEqual([]);
    expect(errors).toContain('HTTP 401');
  });

  it('returns [] when fetch throws (network error) and reports error message', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('network failure'));
    const errors: Array<string | undefined> = [];
    const result = await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      onError: (err: string | undefined) => errors.push(err),
      extractModels: defaultExtract,
    });
    expect(result).toEqual([]);
    expect(errors.some((e) => e?.includes('network failure'))).toBe(true);
  });

  it('redacts exact credential and custom-header values from upstream diagnostics', async () => {
    const canary = 'canary-provider-credential-7f3b';
    const headerCanary = 'canary-header-value-19ad';
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new Error(
        `upstream request failed: Authorization: Bearer ${canary}; x-provider-token: ${headerCanary}`,
      ),
    );
    const errors: Array<string | undefined> = [];

    await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      apiKey: canary,
      headers: { 'x-provider-token': headerCanary },
      onError: (err: string | undefined) => errors.push(err),
      extractModels: defaultExtract,
    });

    const diagnostic = errors.at(-1) ?? '';
    expect(diagnostic).not.toContain(canary);
    expect(diagnostic).not.toContain(headerCanary);
    expect(diagnostic).toContain('***REDACTED***');
  });

  it('redacts sensitive query values before including an endpoint in HTTP diagnostics', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('bad', { status: 401 }));
    const canary = 'canary-query-value-53c1';

    await expect(
      fetchJsonWithTimeout({
        url: `https://api.example.com/v1/models?api_key=${canary}`,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      kind: 'provider-http-failure',
      data: expect.objectContaining({ url: expect.not.stringContaining(canary) }),
    });
  });

  it('returns [] when body is not a JSON object and reports "Invalid response payload"', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify('a string, not an object'), { status: 200 }),
    );
    const errors: Array<string | undefined> = [];
    const result = await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      onError: (err: string | undefined) => errors.push(err),
      extractModels: defaultExtract,
    });
    expect(result).toEqual([]);
    expect(errors).toContain('Invalid response payload');
  });

  it('returns [] when extractor returns null (unrecognized shape)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ not: 'valid' }), { status: 200 }),
    );
    const errors: Array<string | undefined> = [];
    const result = await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      onError: (err: string | undefined) => errors.push(err),
      extractModels: defaultExtract,
    });
    expect(result).toEqual([]);
    expect(errors).toContain('Invalid response payload');
  });
});

describe('provider connection origin enforcement', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('normalizes the endpoint before resolving an env credential', () => {
    vi.stubEnv('ORIGIN_TEST_KEY', 'sk-origin-canary-9f2a');
    const connection = createProviderConnection({
      requestedBaseURL: 'HTTPS://API.EXAMPLE.COM:443/v1/',
      endpointPolicy: fixedOriginPolicy,
      envKeyName: 'ORIGIN_TEST_KEY',
      credentialPrefix: 'sk-',
      offering: 'payg',
    });

    expect(connection.baseURL).toBe('https://api.example.com/v1');
    expect(connection.apiKey()).toBe('sk-origin-canary-9f2a');
  });

  it('rejects a lookalike host before env credential resolution', () => {
    vi.stubEnv('ORIGIN_TEST_KEY', 'sk-origin-canary-9f2a');
    expect(() =>
      createProviderConnection({
        requestedBaseURL: 'https://api.example.com.evil.test/v1',
        endpointPolicy: fixedOriginPolicy,
        envKeyName: 'ORIGIN_TEST_KEY',
        credentialPrefix: 'sk-',
      }),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
  });

  it('accepts an explicit unregistered endpoint policy without registry lookup', () => {
    const connection = createProviderConnection({
      requestedBaseURL: 'https://candidate.example/v1',
      endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://candidate.example/v1' },
      credentialOverride: 'sk-unregistered-canary',
      credentialPrefix: 'sk-',
      offering: 'payg',
    });

    expect(connection.baseURL).toBe('https://candidate.example/v1');
    expect(connection.offering).toBe('payg');
  });
});

describe('provider connection redirect enforcement', () => {
  setupFetchMock();

  it('rejects a cross-origin redirect before the attacker host observes credentials', async () => {
    const credential = 'sk-redirect-canary-4d8e';
    const requests: RequestRecord[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(recordRequest(input, init));
      return new Response(null, {
        status: 302,
        headers: { location: `${attackerOrigin}/collect` },
      });
    });

    const connection = createProviderConnection({
      requestedBaseURL: fixedOriginPolicy.baseURL,
      endpointPolicy: fixedOriginPolicy,
      credentialOverride: credential,
      credentialPrefix: 'sk-',
    });

    await expect(
      connection[endpointPolicyFetch]('https://api.example.com/v1/models', {
        headers: { Authorization: `Bearer ${credential}` },
      }),
    ).rejects.toMatchObject({ kind: 'provider-endpoint-invalid' });

    expect(requests).toEqual([
      {
        method: 'GET',
        url: 'https://api.example.com/v1/models',
        authorization: `Bearer ${credential}`,
        apiKey: undefined,
      },
    ]);
    assertZeroAttackerHostCredentialObservations(requests);
  });
});

describe('provider connection credential prefix validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['sk-', 'tp-wrong-family-canary'],
    ['tp-', 'sk-wrong-family-canary'],
    ['sk-cp-', 'sk-wrong-family-canary'],
  ])('rejects a %s credential family before network access', (prefix, credential) => {
    expect(() =>
      createProviderConnection({
        requestedBaseURL: fixedOriginPolicy.baseURL,
        endpointPolicy: fixedOriginPolicy,
        credentialOverride: credential,
        credentialPrefix: prefix,
      }),
    ).toThrow(expect.objectContaining({ kind: 'provider-credential-prefix-mismatch' }));
  });
});

describe('provider connection offering policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never selects offering from credential presence or prefix', () => {
    vi.stubEnv('OFFERING_TEST_KEY', 'tp-present-canary');
    expect(() =>
      createProviderConnection({
        requestedBaseURL: fixedOriginPolicy.baseURL,
        endpointPolicy: fixedOriginPolicy,
        offering: 'payg',
        envKeyName: 'OFFERING_TEST_KEY',
        credentialPrefix: 'sk-',
      }),
    ).toThrow(expect.objectContaining({ kind: 'provider-credential-prefix-mismatch' }));

    const connection = createProviderConnection({
      requestedBaseURL: fixedOriginPolicy.baseURL,
      endpointPolicy: fixedOriginPolicy,
      offering: 'coding-subscription',
      credentialOverride: 'sk-valid-offering-canary',
      credentialPrefix: 'sk-',
    });
    expect(connection.offering).toBe('coding-subscription');
  });
});
