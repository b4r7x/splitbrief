import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderDef, ProviderOverrides } from './types.js';
import { createGroqProvider } from './groq.js';
import { createTogetherProvider } from './together.js';
import { createLmStudioProvider } from './lm-studio.js';
import { createOllamaProvider } from './ollama.js';
import { createOpenRouterProvider } from './openrouter.js';

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
    name: 'groq',
    create: createGroqProvider,
    defaultBaseURL: 'https://api.groq.com/openai/v1',
    isLocal: false,
    envKey: 'GROQ_API_KEY',
    listEndpoint: 'https://api.groq.com/openai/v1/models',
    successResponse: {
      data: [
        { id: 'llama3-8b-8192', context_window: 8192 },
        { id: 'mixtral-8x7b-32768', context_window: 32768 },
      ],
    },
    modelIds: ['llama3-8b-8192', 'mixtral-8x7b-32768'],
    contextLengthForFirst: 8192,
    contextLengthResponse: {
      data: [{ id: 'llama3-8b-8192', context_window: 8192 }],
    },
    detectUsesListEndpoint: true,
    sendsAuth: true,
  },
  {
    name: 'together',
    create: createTogetherProvider,
    defaultBaseURL: 'https://api.together.xyz/v1',
    isLocal: false,
    envKey: 'TOGETHER_API_KEY',
    listEndpoint: 'https://api.together.xyz/v1/models',
    successResponse: {
      data: [
        { id: 'meta-llama/Llama-3-8b-chat-hf', context_length: 8192 },
        { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', context_length: 32768 },
      ],
    },
    modelIds: ['meta-llama/Llama-3-8b-chat-hf', 'mistralai/Mixtral-8x7B-Instruct-v0.1'],
    contextLengthForFirst: 8192,
    contextLengthResponse: {
      data: [{ id: 'meta-llama/Llama-3-8b-chat-hf', context_length: 8192 }],
    },
    detectUsesListEndpoint: true,
    sendsAuth: true,
  },
  {
    name: 'lm-studio',
    create: createLmStudioProvider,
    defaultBaseURL: 'http://localhost:1234/v1',
    isLocal: true,
    envKey: '',
    listEndpoint: 'http://localhost:1234/v1/models',
    successResponse: {
      data: [{ id: 'deepseek-coder', max_context_length: 16384 }, { id: 'codellama' }],
    },
    modelIds: ['deepseek-coder', 'codellama'],
    contextLengthForFirst: 16384,
    contextLengthResponse: {
      data: [{ id: 'deepseek-coder', max_context_length: 16384 }],
    },
    detectUsesListEndpoint: true,
    sendsAuth: false,
  },
  {
    name: 'ollama',
    create: createOllamaProvider,
    defaultBaseURL: 'http://localhost:11434/v1',
    isLocal: true,
    envKey: 'OLLAMA_API_KEY',
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
  {
    name: 'openrouter',
    create: createOpenRouterProvider,
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    isLocal: false,
    envKey: 'OPENROUTER_API_KEY',
    listEndpoint: 'https://openrouter.ai/api/v1/models',
    successResponse: {
      data: [
        { id: 'openai/gpt-4o', context_length: 128000 },
        { id: 'anthropic/claude-3-opus', context_length: 200000 },
      ],
    },
    modelIds: ['openai/gpt-4o', 'anthropic/claude-3-opus'],
    contextLengthForFirst: 128000,
    contextLengthResponse: {
      data: [{ id: 'openai/gpt-4o', context_length: 128000 }],
    },
    detectUsesListEndpoint: true,
    sendsAuth: true,
  },
];

describe.each(FIXTURES)('$name provider contract', (f) => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    if (f.envKey) {
      originalEnv = process.env[f.envKey];
      process.env[f.envKey] = 'test-key';
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

  it('respects apiBase and apiKey overrides', () => {
    const p = f.create({ apiBase: 'https://override.example/v1', apiKey: 'override-key' });
    expect(p.baseURL).toBe('https://override.example/v1');
    expect(p.apiKey()).toBe('override-key');
  });

  it('listModels returns model IDs on success', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(f.successResponse), { status: 200 }),
    );

    const p = f.create();
    const models = await p.listModels();

    expect(models).toEqual([f.modelIds[0], f.modelIds[1]]);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(url).toBe(f.listEndpoint);
    if (f.sendsAuth) {
      expect((init as RequestInit | undefined)?.headers).toEqual({ Authorization: 'Bearer test-key' });
    }
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
