import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createMetadataProvider } from './metadata.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

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
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const p = createMetadataProvider(
      {
        ...opts,
        modelsUrl: (base) => `${base}/custom/models/path`,
      },
      { apiKey: 'k' },
    );
    await p.listModels();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      'https://api.custom.com/v1/custom/models/path',
      expect.anything(),
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
