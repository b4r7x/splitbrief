import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  API_PROVIDER_VERDICT_CANDIDATE_PATHS,
  getApiProviderDescriptor,
  PASS_API_PROVIDER_IDS,
} from '../../core/providers/api-provider-catalog.js';
import type { ProviderDef, ProviderOverrides } from './types.js';
import { createGroqProvider } from './groq.js';
import { createTogetherProvider } from './together.js';
import { createLmStudioProvider } from './lm-studio.js';
import { createOllamaProvider } from './ollama.js';
import { createOpenRouterProvider } from './openrouter.js';
import {
  KNOWN_PROVIDERS,
  REGISTRY_OMIT_CANDIDATE_IDS,
  REGISTRY_PASS_CANDIDATE_IDS,
} from './registry.js';

const REPO_ROOT = join(import.meta.dirname, '../../..');

function resolveRepoPath(relativePath: string): string {
  return join(REPO_ROOT, relativePath);
}

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

describe('provider verdict admission contract', () => {
  it('derives the retained PASS allowlist from T-044–T-053 verdicts', () => {
    expect([...REGISTRY_PASS_CANDIDATE_IDS]).toEqual([...PASS_API_PROVIDER_IDS]);
  });

  it('keeps every OMIT verdict module absent from the registry', () => {
    for (const id of REGISTRY_OMIT_CANDIDATE_IDS) {
      expect(KNOWN_PROVIDERS).not.toHaveProperty(id);
    }
    for (const candidate of API_PROVIDER_VERDICT_CANDIDATE_PATHS) {
      if ((PASS_API_PROVIDER_IDS as readonly string[]).includes(candidate.id)) continue;
      expect(existsSync(resolveRepoPath(candidate.source))).toBe(false);
      expect(existsSync(resolveRepoPath(candidate.test))).toBe(false);
    }
  });

  it('keeps provider-contract fixtures limited to retained existing factories', () => {
    const fixtureNames = FIXTURES.map((fixture) => fixture.name);
    for (const id of PASS_API_PROVIDER_IDS) {
      expect(fixtureNames).not.toContain(id);
    }
    expect(fixtureNames.toSorted()).toEqual(
      ['groq', 'lm-studio', 'ollama', 'openrouter', 'together'].toSorted(),
    );
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
    const credential = fixtureCredential(f.name, 'override-key');
    const p = f.create({ apiBase, apiKey: credential });
    expect(p.baseURL).toBe(apiBase);
    expect(p.apiKey()).toBe(credential);
  });

  if (f.envKey) {
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

  it('listModels returns model IDs on success', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(f.successResponse), { status: 200 }),
    );

    const p = f.create();
    const models = await p.listModels();

    expect(models).toEqual([f.modelIds[0], f.modelIds[1]]);
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
