import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  fetchJsonWithTimeout,
  extractOpenAIModelList,
  isOpenAIModelList,
  fetchModelList,
  createMetadataProvider,
  createProviderShell,
} from './client.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

describe('createProviderShell', () => {
  it('tracks and exposes last error through trackError / getLastError', () => {
    const shell = createProviderShell({ name: 'p', baseURL: 'https://x', isLocal: false });
    expect(shell.getLastError()).toBeUndefined();
    shell.trackError('boom');
    expect(shell.getLastError()).toBe('boom');
    shell.trackError(undefined);
    expect(shell.getLastError()).toBeUndefined();
  });
});

describe('isOpenAIModelList / extractOpenAIModelList', () => {
  it('isOpenAIModelList accepts canonical shape', () => {
    expect(isOpenAIModelList({ data: [{ id: 'a' }, { id: 'b' }] })).toBe(true);
  });

  it('isOpenAIModelList rejects non-canonical shapes', () => {
    expect(isOpenAIModelList({ models: [{ id: 'a' }] })).toBe(false);
    expect(isOpenAIModelList(null)).toBe(false);
    expect(isOpenAIModelList('nope')).toBe(false);
    expect(isOpenAIModelList({ data: 'nope' })).toBe(false);
  });

  it('extractOpenAIModelList maps each entry via mapper', () => {
    const ids = extractOpenAIModelList(
      { data: [{ id: 'a', extra: 1 }, { id: 'b' }] },
      (m) => m.id.toUpperCase(),
    );
    expect(ids).toEqual(['A', 'B']);
  });

  it('extractOpenAIModelList returns [] for invalid input', () => {
    expect(extractOpenAIModelList({ bad: 'shape' }, (m) => m.id)).toEqual([]);
  });
});

describe('fetchJsonWithTimeout', () => {
  setupFetchMock();

  it('returns parsed JSON on 2xx', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ hello: 'world' }), { status: 200 }),
    );
    const result = await fetchJsonWithTimeout('https://api.example.com/v1', 1000);
    expect(result).toEqual({ hello: 'world' });
  });

  it('throws on non-ok status with HTTP code in message', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('err', { status: 503 }));
    await expect(fetchJsonWithTimeout('https://api.example.com/v1', 1000)).rejects.toThrow('HTTP 503');
  });

  it('aborts with a AbortError when the timeout fires before response', async () => {
    let signalRef: AbortSignal | undefined;
    vi.mocked(globalThis.fetch).mockImplementationOnce((_url, init) => {
      signalRef = (init as RequestInit | undefined)?.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        // Reject when the signal's abort event fires (real fetch behaviour).
        signalRef?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    await expect(fetchJsonWithTimeout('https://slow.example.com', 5)).rejects.toThrow();
    // The controller attached to the request should be aborted after timeout elapses.
    expect(signalRef?.aborted).toBe(true);
  });
});

describe('fetchModelList', () => {
  setupFetchMock();

  const defaultExtract = (data: unknown): Array<{ id: string }> | null => {
    if (!isOpenAIModelList(data)) return null;
    return extractOpenAIModelList(data, (m) => ({ id: m.id }));
  };

  it('returns extracted models on 200 + valid payload and clears error on onError', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }), { status: 200 }),
    );
    const errors: Array<string | undefined> = [];
    const result = await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      apiKey: 'k',
      onError: (err) => errors.push(err),
      extractModels: defaultExtract,
    });
    expect(result).toEqual([{ id: 'm1' }, { id: 'm2' }]);
    // Last onError call should clear the error.
    expect(errors.at(-1)).toBeUndefined();
  });

  it('sends Authorization header when apiKey provided and no explicit headers', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      apiKey: 'secret-token',
      extractModels: defaultExtract,
    });
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const init = call?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.['Authorization']).toBe('Bearer secret-token');
  });

  it('uses custom headers verbatim when provided (no Authorization injection)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      apiKey: 'should-be-ignored',
      headers: { 'x-api-key': 'custom' },
      extractModels: defaultExtract,
    });
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toEqual({ 'x-api-key': 'custom' });
  });

  it('returns [] on non-ok and reports HTTP status via onError', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('bad', { status: 401 }));
    const errors: Array<string | undefined> = [];
    const result = await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      onError: (err) => errors.push(err),
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
      onError: (err) => errors.push(err),
      extractModels: defaultExtract,
    });
    expect(result).toEqual([]);
    expect(errors.some((e) => e?.includes('network failure'))).toBe(true);
  });

  it('returns [] when body is not a JSON object and reports "Invalid response payload"', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify('a string, not an object'), { status: 200 }),
    );
    const errors: Array<string | undefined> = [];
    const result = await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      onError: (err) => errors.push(err),
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
      onError: (err) => errors.push(err),
      extractModels: defaultExtract,
    });
    expect(result).toEqual([]);
    expect(errors).toContain('Invalid response payload');
  });

  it('omits Authorization when neither apiKey nor headers are provided', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await fetchModelList({
      endpoint: 'https://api.example.com/v1/models',
      extractModels: defaultExtract,
    });
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    // No init argument (or undefined) means no headers.
    expect(call?.[1]).toBeUndefined();
  });
});

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
      new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b', context: 100 }] }), { status: 200 }),
    );
    const p = createMetadataProvider(opts);
    expect(await p.listModels()).toEqual(['a', 'b']);
  });

  it('returns [] without calling fetch when non-local provider has no API key', async () => {
    const p = createMetadataProvider(opts);
    const models = await p.listModels();
    expect(models).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fetches without auth when provider is local, regardless of API key', async () => {
    const localOpts = { ...opts, isLocal: true };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 }),
    );
    const p = createMetadataProvider(localOpts);
    expect(await p.listModels()).toEqual(['x']);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('honours overrides.apiBase and overrides.apiKey', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const p = createMetadataProvider(opts, { apiBase: 'https://override.example/v1', apiKey: 'override-key' });
    expect(p.baseURL).toBe('https://override.example/v1');
    expect(p.apiKey()).toBe('override-key');
    await p.listModels();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://override.example/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer override-key' } }),
    );
  });

  it('uses custom modelsUrl when provided', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const p = createMetadataProvider({
      ...opts,
      modelsUrl: (base) => `${base}/custom/models/path`,
    }, { apiKey: 'k' });
    await p.listModels();
    const firstCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(firstCall?.[0]).toBe('https://api.custom.com/v1/custom/models/path');
  });

  it('uses custom headers factory (non-bearer auth)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const p = createMetadataProvider({
      ...opts,
      headers: (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
    }, { apiKey: 'secret' });
    await p.listModels();
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toEqual({ 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' });
  });

  it('uses custom extractModels for non-OpenAI list shapes', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'qwen:7b' }, { name: 'llama:8b' }] }), { status: 200 }),
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
      new Response(JSON.stringify({
        data: [
          { id: 'ok-1', version: 1 },
          { id: 'bad-1' /* missing version → fallback */ },
        ],
      }), { status: 200 }),
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
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('bad', { status: 500 }));
    const p = createMetadataProvider(opts);
    await p.listModels();
    expect(p.getLastError?.()).toBe('HTTP 500');

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'a' }] }), { status: 200 }),
    );
    await p.listModels();
    expect(p.getLastError?.()).toBeUndefined();
  });

  it('detectContextLength returns mapped context for matching model, null otherwise', async () => {
    process.env['CUSTOM_API_KEY'] = 'key';
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          { id: 'alpha', context: 32768 },
          { id: 'beta' },
        ],
      }), { status: 200 }),
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
