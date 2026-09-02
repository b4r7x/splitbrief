import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getApiProviderDescriptor } from '../../core/providers/api-provider-catalog.js';
import { FORBIDDEN_API_PROVIDER_IDS } from '../../core/providers/api-provider-verdicts.js';
import type { ProviderDef, ProviderOverrides } from './types.js';
import { createLmStudioProvider } from './lm-studio.js';
import { createOllamaProvider } from './ollama.js';

/** A credential of the provider's own family; a foreign prefix fails admission. */
function fixtureCredential(provider: string, suffix: string): string {
  return `${getApiProviderDescriptor(provider)?.credentialPrefix ?? ''}${suffix}`;
}

interface ProviderFixture {
  name: string;
  create: (overrides?: ProviderOverrides) => ProviderDef;
  defaultBaseURL: string;
  isLocal: boolean;
  /** Env var name used for API key. Empty string if unused. */
  envKey: string;
  /** URL the provider hits when listing models. */
  listEndpoint: string;
  /** A successful /models response body listing the two model IDs below. */
  successResponse: unknown;
  /** The two model IDs present in successResponse. */
  modelIds: [string, string];
  /** Context length that should be detected for modelIds[0]. */
  contextLengthForFirst: number;
  /** Response body where modelIds[0] has a context length; drives detectContextLength tests. */
  contextLengthResponse: unknown;
  /** True when detectContextLength uses the list endpoint (false for Ollama which hits /api/show). */
  detectUsesListEndpoint: boolean;
  /** True when the provider sends Authorization: Bearer <key>. */
  sendsAuth: boolean;
}

const FIXTURES: ProviderFixture[] = [
  {
    name: 'lm-studio',
    create: createLmStudioProvider,
    defaultBaseURL: 'http://localhost:1234/v1',
    isLocal: true,
    envKey: '',
    listEndpoint: 'http://localhost:1234/api/v1/models',
    successResponse: {
      models: [
        { key: 'deepseek-coder', type: 'llm', max_context_length: 16384 },
        { key: 'codellama', type: 'llm' },
      ],
    },
    modelIds: ['deepseek-coder', 'codellama'],
    contextLengthForFirst: 16384,
    contextLengthResponse: {
      models: [{ key: 'deepseek-coder', type: 'llm', max_context_length: 16384 }],
    },
    detectUsesListEndpoint: true,
    sendsAuth: false,
  },
  {
    name: 'ollama',
    create: createOllamaProvider,
    defaultBaseURL: 'http://localhost:11434/v1',
    isLocal: true,
    envKey: 'OLLAMA_LOCAL_API_KEY',
    listEndpoint: 'http://localhost:11434/api/tags',
    successResponse: {
      models: [{ name: 'qwen:7b' }, { name: 'llama3:8b' }],
    },
    modelIds: ['qwen:7b', 'llama3:8b'],
    contextLengthForFirst: 0, // unused — detection goes through /api/show
    contextLengthResponse: null,
    detectUsesListEndpoint: false,
    sendsAuth: false,
  },
];

describe('provider verdict admission contract', () => {
  it('keeps provider-contract fixtures limited to retained existing factories', () => {
    const fixtureNames = FIXTURES.map((fixture) => fixture.name);
    for (const id of FORBIDDEN_API_PROVIDER_IDS) {
      expect(fixtureNames).not.toContain(id);
    }
    expect(fixtureNames.toSorted()).toEqual(['lm-studio', 'ollama'].toSorted());
  });
});

describe.each(FIXTURES)('$name provider contract', (f) => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    if (f.envKey) {
      originalEnv = process.env[f.envKey];
      process.env[f.envKey] = fixtureCredential(f.name, 'test-key');
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (f.envKey) {
      if (originalEnv === undefined) delete process.env[f.envKey];
      else process.env[f.envKey] = originalEnv;
    }
  });

  it('exposes default baseURL and locality', () => {
    const p = f.create();
    expect(p.name).toBe(f.name);
    expect(p.baseURL).toBe(f.defaultBaseURL);
    expect(p.isLocal).toBe(f.isLocal);
  });

  it('respects policy-valid apiBase and apiKey overrides', () => {
    const apiBase =
      f.name === 'ollama' || f.name === 'lm-studio'
        ? 'http://127.0.0.1:22000/v1'
        : f.defaultBaseURL;
    const apiKey =
      f.name === 'ollama' ? 'env:OLLAMA_LOCAL_API_KEY' : fixtureCredential(f.name, 'override-key');
    const expectedApiKey = f.name === 'ollama' ? fixtureCredential(f.name, 'test-key') : apiKey;
    const p = f.create({ apiBase, apiKey });
    expect(p.baseURL).toBe(apiBase);
    expect(p.apiKey()).toBe(expectedApiKey);
  });

  if (f.envKey && f.name !== 'ollama') {
    it('rejects a credential from another provider family before any request', () => {
      const descriptor = getApiProviderDescriptor(f.name);
      if (descriptor?.credentialPrefix == null) return;
      const provider = f.create({ apiKey: `foreign-${descriptor.credentialPrefix}key` });

      expect(() => provider.apiKey()).toThrow(
        expect.objectContaining({ kind: 'provider-credential-prefix-mismatch' }),
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  }

  if (f.name !== 'ollama') {
    it('rejects a policy-invalid apiBase before resolving credentials', () => {
      delete process.env.PROVIDER_CONTRACT_MISSING;

      expect(() =>
        f.create({
          apiBase: 'https://override.example/v1',
          apiKey: 'env:PROVIDER_CONTRACT_MISSING',
        }),
      ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
    });
  }

  it('listModels returns model IDs with the expected default authorization', async () => {
    let request: Request | undefined;
    vi.mocked(globalThis.fetch).mockImplementationOnce((input, init) => {
      request = new Request(input, init);
      return Promise.resolve(new Response(JSON.stringify(f.successResponse), { status: 200 }));
    });

    const p = f.create();
    const models = await p.listModels();

    expect(models).toEqual([f.modelIds[0], f.modelIds[1]]);
    expect(request?.headers.get('authorization')).toBe(
      f.sendsAuth ? `Bearer ${fixtureCredential(f.name, 'test-key')}` : null,
    );
  });

  it('accepts cancellation options and rejects when the caller aborts', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.mocked(globalThis.fetch).mockImplementationOnce((input, init) => {
      const request = new Request(input, init);
      requestSignal = request.signal;
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(new DOMException('The provider list was aborted.', 'AbortError')),
          { once: true },
        );
      });
    });

    const pending = f.create().listModels({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('listModels returns empty on non-ok response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('err', { status: 500 }));
    const p = f.create();
    expect(await p.listModels()).toEqual([]);
  });

  it('listModels returns empty on fetch error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('network'));
    const p = f.create();
    expect(await p.listModels()).toEqual([]);
  });

  it('listModels returns empty on invalid response shape', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ invalid: 'shape' }), { status: 200 }),
    );
    const p = f.create();
    expect(await p.listModels()).toEqual([]);
  });

  if (!f.isLocal && f.envKey) {
    it('listModels returns empty when API key missing', async () => {
      delete process.env[f.envKey];
      const p = f.create();
      expect(await p.listModels()).toEqual([]);
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    });
  }

  if (f.detectUsesListEndpoint) {
    it('detectContextLength returns context length for known model', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify(f.contextLengthResponse), { status: 200 }),
      );
      const p = f.create();
      expect(await p.detectContextLength?.(f.modelIds[0])).toBe(f.contextLengthForFirst);
    });

    it('detectContextLength returns null for unknown model', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify(f.contextLengthResponse), { status: 200 }),
      );
      const p = f.create();
      expect(await p.detectContextLength?.('no-such-model')).toBeNull();
    });
  }
});
