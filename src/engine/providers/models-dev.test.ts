import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchModelsDevCatalog, getModelsForProvider } from './models-dev.js';
import { getModelsDevEntries } from './model/resolution.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

const FIXTURE: ModelsDevCatalog = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 200000, output: 8192 },
        temperature: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
      'claude-haiku-3': {
        id: 'claude-haiku-3',
        name: 'Claude Haiku 3',
        cost: { input: 0.25, output: 1.25 },
        limit: { context: 200000, output: 4096 },
      },
    },
  },
  lmstudio: {
    id: 'lmstudio',
    name: 'LM Studio',
    models: {
      'qwen2.5-7b': {
        id: 'qwen2.5-7b',
        name: 'Qwen 2.5 7B',
        cost: { input: 0, output: 0 },
        limit: { context: 32768 },
      },
    },
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    models: {
      'llama3.2': {
        id: 'llama3.2',
        name: 'Llama 3.2',
        cost: { input: 0, output: 0 },
        limit: { context: 131072 },
      },
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-4o': {
        id: 'gpt-4o',
        name: 'GPT-4o',
        cost: { input: 2.5, output: 10 },
        limit: { context: 128000 },
      },
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        cost: {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          tiers: [
            {
              input: 5,
              output: 22.5,
              cache_read: 0.5,
              tier: { type: 'context', size: 272000 },
            },
          ],
        },
        limit: { context: 400000 },
      },
    },
  },
};

type RequestRecord = Readonly<{
  method: string;
  pathname: string;
  authorization: string | undefined;
  ifNoneMatch: string | undefined;
}>;

async function withModelsDevServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
  run: (input: Readonly<{ sourceUrl: string; requests: RequestRecord[] }>) => Promise<void>,
): Promise<void> {
  const requests: RequestRecord[] = [];
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      pathname: new URL(request.url ?? '/', 'http://models-dev.invalid').pathname,
      authorization:
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined,
      ifNoneMatch:
        typeof request.headers['if-none-match'] === 'string'
          ? request.headers['if-none-match']
          : undefined,
    });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP Models.dev test server address.');
  }

  try {
    await run({ sourceUrl: `http://127.0.0.1:${address.port}/api.json`, requests });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('getModelsForProvider', () => {
  it('maps Models.dev models to DetectedModel[] with paid and sparse pricing fields', () => {
    const models = getModelsForProvider(FIXTURE, 'anthropic');
    expect(models).toHaveLength(2);
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    const haiku = models.find((m) => m.id === 'claude-haiku-3');
    expect(sonnet).toMatchObject({
      id: 'claude-sonnet-4-6',
      pricingInput: 3,
      pricingOutput: 15,
      pricingCacheRead: 0.3,
      pricingCacheWrite: 3.75,
      contextLength: 200000,
      maxOutputTokens: 8192,
      supportsTemperature: true,
      supportsReasoning: true,
      supportsImages: true,
      isFree: false,
    });
    expect(haiku).toMatchObject({
      id: 'claude-haiku-3',
      isFree: false,
    });
  });

  it('preserves models.dev context pricing tiers', () => {
    const models = getModelsForProvider(FIXTURE, 'openai');
    const gpt = models.find((m) => m.id === 'gpt-5.4');
    expect(gpt?.pricingTiers).toEqual([
      {
        type: 'context',
        thresholdTokens: 272000,
        inputPer1M: 5,
        outputPer1M: 22.5,
        cacheReadPer1M: 0.5,
      },
    ]);
  });

  it('normalizes legacy context_over_200k when no equivalent explicit tier exists', () => {
    const catalog: ModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: {
          legacy: {
            id: 'legacy',
            cost: {
              input: 1,
              output: 2,
              context_over_200k: { input: 3, output: 4, cache_read: 0.3 },
            },
          },
        },
      },
    };
    const models = getModelsForProvider(catalog, 'openai');
    expect(models.at(0)?.pricingTiers).toEqual([
      {
        type: 'context',
        thresholdTokens: 200000,
        inputPer1M: 3,
        outputPer1M: 4,
        cacheReadPer1M: 0.3,
      },
    ]);
  });

  it('ignores unsupported pricing tier shapes', () => {
    const catalog: ModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: {
          odd: {
            id: 'odd',
            cost: {
              input: 1,
              output: 2,
              tiers: [{ input: 9, tier: { type: 'time', size: 'large' } }],
            },
          },
        },
      },
    };
    const models = getModelsForProvider(catalog, 'openai');
    expect(models.at(0)?.pricingTiers).toBeUndefined();
  });

  it.each([{ providerId: 'lm-studio', modelId: 'qwen2.5-7b' }] as const)(
    'maps models.dev catalog aliases to $providerId',
    ({ providerId, modelId }) => {
      const models = getModelsForProvider(FIXTURE, providerId);
      expect(models).toHaveLength(1);
      expect(models.at(0)?.id).toBe(modelId);
    },
  );

  it('leaves maxOutputTokens undefined when limit.output is absent', () => {
    const models = getModelsForProvider(FIXTURE, 'ollama');
    expect(models.at(0)?.maxOutputTokens).toBeUndefined();
  });

  it('marks zero-cost local models as free', () => {
    const models = getModelsForProvider(FIXTURE, 'lm-studio');
    expect(models.at(0)).toMatchObject({ id: 'qwen2.5-7b', isFree: true });
  });

  it.each([
    { label: 'unknown provider', catalog: FIXTURE, providerId: 'openrouter' },
    { label: 'empty catalog', catalog: {}, providerId: 'openai' },
  ] as const)('returns empty array for $label', ({ catalog, providerId }) => {
    expect(getModelsForProvider(catalog, providerId)).toEqual([]);
  });

  it('returns models with undefined pricing fields when the catalog omits cost', () => {
    const catalog: ModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: {
          'gpt-no-cost': { id: 'gpt-no-cost' },
        },
      },
    };
    const models = getModelsForProvider(catalog, 'openai');
    expect(models.at(0)?.pricingInput).toBeUndefined();
    expect(models.at(0)?.pricingOutput).toBeUndefined();
    expect(models.at(0)?.isFree).toBeUndefined();
    expect(models.at(0)?.contextLength).toBeUndefined();
  });

  it('preserves models.dev metadata alongside pricing without conflating release and update dates', () => {
    const catalog: ModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: {
          'openai/gpt-5.4-20260101': {
            id: 'openai/gpt-5.4-20260101',
            name: 'GPT 5.4 Pinned',
            status: 'deprecated',
            cost: { input: 2, output: 8 },
            limit: { input: 128_000, context: 256_000, output: 32_768 },
            modalities: { input: ['text', 'image'], output: ['text', 'audio'] },
            tool_call: true,
            structured_output: false,
            release_date: '2025-12-01',
            last_updated: '2026-02-14',
          },
        },
      },
    };
    const [model] = getModelsForProvider(catalog, 'openai');

    expect(model).toMatchObject({
      id: 'openai/gpt-5.4-20260101',
      providerId: 'openai',
      modelId: 'openai/gpt-5.4-20260101',
      displayName: 'GPT 5.4 Pinned',
      lifecycle: 'deprecated',
      pricingInput: 2,
      pricingOutput: 8,
      maximumInputTokens: 128_000,
      maximumContextTokens: 256_000,
      maximumOutputTokens: 32_768,
      inputModalities: ['text', 'image'],
      outputModalities: ['text', 'audio'],
      supportsToolCalls: true,
      supportsStructuredOutput: false,
      releaseDate: '2025-12-01',
      updatedDate: '2026-02-14',
    });
    expect(model?.contextLength).toBe(256_000);
    expect(model?.maxOutputTokens).toBe(32_768);
  });

  it('maps models.dev reasoning_options into the model ladder', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-opus-5': {
            id: 'claude-opus-5',
            reasoning_options: [
              { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
            ],
          },
          'claude-sonnet-5': {
            id: 'claude-sonnet-5',
            reasoning_options: [
              { type: 'toggle' },
              { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
            ],
          },
          'claude-haiku-4-5': {
            id: 'claude-haiku-4-5',
            reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
          },
          'toggle-only': { id: 'toggle-only', reasoning_options: [{ type: 'toggle' }] },
          'empty-options': { id: 'empty-options', reasoning_options: [] },
          'effort-without-values': {
            id: 'effort-without-values',
            reasoning_options: [{ type: 'effort' }],
          },
          'no-reasoning-options': { id: 'no-reasoning-options' },
        },
      },
    };

    const byId = new Map(
      getModelsForProvider(catalog, 'anthropic').map((model) => [model.id, model]),
    );

    expect(byId.get('claude-opus-5')?.nativeReasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(byId.get('claude-sonnet-5')?.nativeReasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(byId.get('claude-haiku-4-5')?.nativeReasoningEfforts).toEqual([]);
    expect(byId.get('toggle-only')?.nativeReasoningEfforts).toEqual([]);
    expect(byId.get('empty-options')?.nativeReasoningEfforts).toEqual([]);
    expect(byId.get('effort-without-values')?.nativeReasoningEfforts).toEqual([]);
    expect(byId.get('no-reasoning-options')).not.toHaveProperty('nativeReasoningEfforts');
  });

  it('preserves metadata through the live resolver without rewriting a provider-qualified ID', () => {
    const catalog: ModelsDevCatalog = {
      ollama: {
        id: 'ollama',
        models: {
          'openai/gpt-5.4-20260101': {
            id: 'openai/gpt-5.4-20260101',
            name: 'GPT 5.4 Pinned',
            status: 'active',
            limit: { input: 64_000, context: 128_000, output: 16_000 },
            modalities: { input: ['text'], output: ['text'] },
            tool_call: true,
            structured_output: true,
            release_date: '2025-11-18',
            last_updated: '2026-02-14',
          },
        },
      },
    };

    const [model] = getModelsDevEntries('ollama', makeModelCacheAccessor({ catalog }));

    expect(model).toMatchObject({
      id: 'openai/gpt-5.4-20260101',
      providerId: 'ollama',
      modelId: 'openai/gpt-5.4-20260101',
      displayName: 'GPT 5.4 Pinned',
      lifecycle: 'active',
      maximumInputTokens: 64_000,
      maximumContextTokens: 128_000,
      maximumOutputTokens: 16_000,
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsToolCalls: true,
      supportsStructuredOutput: true,
      releaseDate: '2025-11-18',
      updatedDate: '2026-02-14',
    });
  });

  it('merges sparse records for one exact source identity without discarding metadata', () => {
    const catalog: ModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: {
          base: {
            id: 'openai/acme/model:latest',
            limit: { input: 128_000, context: 256_000 },
            modalities: { input: ['text', 'image'] },
            release_date: '2025-10-01',
          },
          details: {
            id: 'openai/acme/model:latest',
            name: 'Acme Latest',
            status: 'active',
            limit: { output: 32_768 },
            modalities: { output: ['text'] },
            tool_call: true,
            structured_output: true,
            last_updated: '2026-02-14',
          },
        },
      },
    };

    const models = getModelsForProvider(catalog, 'openai');
    const [model] = models;

    expect(models).toHaveLength(1);
    expect(model).toMatchObject({
      id: 'openai/acme/model:latest',
      providerId: 'openai',
      modelId: 'openai/acme/model:latest',
      displayName: 'Acme Latest',
      lifecycle: 'active',
      maximumInputTokens: 128_000,
      maximumContextTokens: 256_000,
      maximumOutputTokens: 32_768,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      supportsToolCalls: true,
      supportsStructuredOutput: true,
      releaseDate: '2025-10-01',
      updatedDate: '2026-02-14',
    });
  });

  it('keeps the reasoning ladder when sparse records for one identity merge', () => {
    const catalog: ModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: {
          'ladder-base': {
            id: 'ladder',
            reasoning_options: [{ type: 'effort', values: ['low'] }],
          },
          'ladder-details': {
            id: 'ladder',
            reasoning_options: [{ type: 'effort', values: ['medium', 'high'] }],
          },
          'silent-base': {
            id: 'silent',
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
          },
          'silent-details': { id: 'silent', name: 'Silent Details' },
        },
      },
    };

    const byId = new Map(getModelsForProvider(catalog, 'openai').map((model) => [model.id, model]));

    expect(byId.get('ladder')?.nativeReasoningEfforts).toEqual(['medium', 'high']);
    expect(byId.get('silent')).toMatchObject({
      displayName: 'Silent Details',
      nativeReasoningEfforts: ['low', 'high'],
    });
  });
});

describe('fetchModelsDevCatalog', () => {
  setupFetchMock();
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = createTempDir('models-dev-fetch');
  });

  afterEach(() => {
    cleanupTempDir(cacheDir);
  });

  it('returns parsed catalog on success', async () => {
    vi.unstubAllGlobals();
    await withModelsDevServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(FIXTURE));
      },
      async ({ sourceUrl, requests }) => {
        expect(await fetchModelsDevCatalog({ cacheDir, sourceUrl })).toEqual(FIXTURE);
        expect(requests).toEqual([
          {
            method: 'GET',
            pathname: '/api.json',
            authorization: undefined,
            ifNoneMatch: undefined,
          },
        ]);
      },
    );
  });

  it('throws on non-ok response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('error', { status: 500 }));

    await expect(fetchModelsDevCatalog({ cacheDir })).rejects.toThrow('HTTP 500');
  });

  it('throws on network error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('network error'));

    await expect(fetchModelsDevCatalog({ cacheDir })).rejects.toThrow(
      'Models.dev catalog request failed.',
    );
  });
});
