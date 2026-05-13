import { describe, it, expect } from 'vitest';
import {
  NULL_CACHE,
  getBundledModels,
  getRuntimeLookupProvider,
  getModelsDevEntries,
  lookupModelsDevModel,
  lookupRuntimeModel,
  findModelMetadata,
  findKnownModel,
  getDefaultKnownModel,
  getEffectiveModelId,
} from './resolution.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import type { ProviderId } from '../../../core/schemas/enums.js';
import { makeModelCacheAccessor as makeCache } from '#testing/helpers/factories/model-cache.js';

describe('NULL_CACHE', () => {
  it('returns null for both accessors regardless of input', () => {
    expect(NULL_CACHE.getModelsDevCatalog()).toBeNull();
    expect(NULL_CACHE.getProviderModels('anthropic')).toBeNull();
    expect(NULL_CACHE.getProviderModels('ollama')).toBeNull();
  });
});

describe('getRuntimeLookupProvider', () => {
  it('maps agent-sdk to anthropic (runtime shares model catalog)', () => {
    expect(getRuntimeLookupProvider('agent-sdk')).toBe('anthropic');
  });

  it('returns the provider id unchanged for non agent-sdk providers', () => {
    expect(getRuntimeLookupProvider('anthropic')).toBe('anthropic');
    expect(getRuntimeLookupProvider('openai')).toBe('openai');
    expect(getRuntimeLookupProvider('claude-code')).toBe('claude-code');
    expect(getRuntimeLookupProvider('ollama')).toBe('ollama');
  });
});

describe('getBundledModels', () => {
  it('returns the list of KNOWN_MODELS for a provider with entries', () => {
    const bundled = getBundledModels('anthropic');
    expect(bundled.length).toBeGreaterThan(0);
    expect(bundled.some((m) => m.name === 'claude-sonnet-4-6')).toBe(true);
  });

  it('returns empty array for a provider with no bundled models', () => {
    // groq is declared with [] in KNOWN_MODELS
    expect(getBundledModels('groq')).toEqual([]);
  });
});

describe('findKnownModel', () => {
  it('matches by name', () => {
    const found = findKnownModel('anthropic', 'claude-sonnet-4-6');
    expect(found?.name).toBe('claude-sonnet-4-6');
  });

  it('matches case-insensitively via normalization', () => {
    const found = findKnownModel('anthropic', 'CLAUDE-SONNET-4-6');
    expect(found?.name).toBe('claude-sonnet-4-6');
  });

  it('returns undefined when model is unknown to provider', () => {
    expect(findKnownModel('anthropic', 'gpt-5-super-ultra')).toBeUndefined();
  });

  it('matches by catalogModelId when name does not match', () => {
    // claude-code has { name: 'opus', catalogModelId: 'claude-opus-4-6' }
    const found = findKnownModel('claude-code', 'claude-opus-4-6');
    expect(found?.name).toBe('opus');
    expect(found?.catalogModelId).toBe('claude-opus-4-6');
  });
});

describe('getDefaultKnownModel', () => {
  it('returns entry flagged isDefault', () => {
    const def = getDefaultKnownModel('anthropic');
    expect(def?.isDefault).toBe(true);
    expect(def?.name).toBe('claude-sonnet-4-6');
  });

  it('returns undefined when no default is flagged', () => {
    expect(getDefaultKnownModel('groq')).toBeUndefined();
  });
});

describe('getEffectiveModelId', () => {
  // Table-driven cases covering user-selected vs fallback precedence.
  const cases: Array<{
    name: string;
    providerId: ProviderId;
    modelId?: string;
    expected: string | undefined;
  }> = [
    {
      name: 'user-selected exact bundled name returns catalogModelId when present',
      providerId: 'claude-code',
      modelId: 'opus',
      expected: 'claude-opus-4-6',
    },
    {
      name: 'user-selected bundled without catalogModelId returns name',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      expected: 'claude-sonnet-4-6',
    },
    {
      name: 'user-selected unknown model falls through to raw selected string',
      providerId: 'anthropic',
      modelId: 'my-custom-fine-tune',
      expected: 'my-custom-fine-tune',
    },
    {
      name: 'empty/whitespace model falls back to default',
      providerId: 'anthropic',
      modelId: '   ',
      expected: 'claude-sonnet-4-6',
    },
    {
      name: 'undefined model falls back to default',
      providerId: 'anthropic',
      expected: 'claude-sonnet-4-6',
    },
    {
      name: 'default resolution follows catalogModelId when set',
      providerId: 'openai',
      expected: 'gpt-5.4', // openai default is { name: 'auto', catalogModelId: 'gpt-5.4' }
    },
    {
      name: 'provider without default returns undefined',
      providerId: 'groq',
      expected: undefined,
    },
    {
      name: 'selected model is trimmed before lookup',
      providerId: 'anthropic',
      modelId: '  claude-sonnet-4-6  ',
      expected: 'claude-sonnet-4-6',
    },
  ];

  it.each(cases)('$name', ({ providerId, modelId, expected }) => {
    expect(getEffectiveModelId(providerId, modelId)).toBe(expected);
  });
});

describe('getModelsDevEntries', () => {
  it('returns [] when catalog is absent', () => {
    expect(getModelsDevEntries('anthropic', NULL_CACHE)).toEqual([]);
  });

  it('merges entries from configured sources into a single DetectedModel list', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-sonnet-4-6': { id: 'claude-sonnet-4-6' },
          'claude-opus-4-6': { id: 'claude-opus-4-6' },
        },
      },
    };
    const cache = makeCache({ catalog });
    const entries = getModelsDevEntries('anthropic', cache);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(['claude-opus-4-6', 'claude-sonnet-4-6']);
  });

  it('applies per-source include filter (claude-code filters to claude-sonnet/opus only)', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-sonnet-4-6': { id: 'claude-sonnet-4-6' },
          'claude-haiku-3': { id: 'claude-haiku-3' }, // not sonnet/opus — should be filtered out
        },
      },
    };
    const entries = getModelsDevEntries('claude-code', makeCache({ catalog }));
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).not.toContain('claude-haiku-3');
  });

  it('aider merges entries from anthropic and openai (two sources)', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6' } },
      },
      openai: {
        id: 'openai',
        models: { 'gpt-5.4': { id: 'gpt-5.4' } },
      },
    };
    const entries = getModelsDevEntries('aider', makeCache({ catalog }));
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(['claude-sonnet-4-6', 'gpt-5.4']);
  });

  it('deduplicates matching IDs across sources, merging metadata', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', limit: { context: 1000000 } },
        },
      },
      openai: {
        id: 'openai',
        // aider also looks at openai — include one that looks like an OpenAI tool model
        models: { 'gpt-5.4': { id: 'gpt-5.4' } },
      },
    };
    const entries = getModelsDevEntries('aider', makeCache({ catalog }));
    // Sanity: no duplicate ids.
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns [] for provider whose sources are not present in catalog', () => {
    const catalog: ModelsDevCatalog = {
      // has only a provider we are NOT querying
      openai: { id: 'openai', models: { 'gpt-5.4': { id: 'gpt-5.4' } } },
    };
    expect(getModelsDevEntries('together', makeCache({ catalog }))).toEqual([]);
  });
});

describe('lookupModelsDevModel', () => {
  it('finds matching entry by id with normalized comparison', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6' } },
      },
    };
    const cache = makeCache({ catalog });
    const entry = lookupModelsDevModel('anthropic', 'claude-sonnet-4-6', cache);
    expect(entry?.id).toBe('claude-sonnet-4-6');
  });

  it('returns null when id does not match any entry', () => {
    expect(lookupModelsDevModel('anthropic', 'unknown', makeCache({ catalog: {} }))).toBeNull();
  });

  it('returns null when catalog is absent', () => {
    expect(lookupModelsDevModel('anthropic', 'claude-sonnet-4-6', NULL_CACHE)).toBeNull();
  });
});

describe('lookupRuntimeModel', () => {
  it('looks up in runtime provider cache keyed by resolved provider id', () => {
    const cache = makeCache({
      providerModels: {
        anthropic: [{ id: 'claude-sonnet-4-6', contextLength: 1000000 }],
      },
    });
    const found = lookupRuntimeModel('anthropic', 'claude-sonnet-4-6', cache);
    expect(found?.contextLength).toBe(1000000);
  });

  it('maps agent-sdk lookups through to anthropic cache bucket', () => {
    const cache = makeCache({
      providerModels: {
        anthropic: [{ id: 'claude-sonnet-4-6', contextLength: 999 }],
      },
    });
    const found = lookupRuntimeModel('agent-sdk', 'claude-sonnet-4-6', cache);
    expect(found?.contextLength).toBe(999);
  });

  it('returns null when runtime cache has no entries for the provider', () => {
    expect(lookupRuntimeModel('ollama', 'qwen:7b', makeCache({}))).toBeNull();
  });
});

describe('findModelMetadata', () => {
  it('prefers models-dev catalog over runtime cache when both match', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        id: 'anthropic',
        models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', limit: { context: 111 } } },
      },
    };
    const cache = makeCache({
      catalog,
      providerModels: {
        anthropic: [{ id: 'claude-sonnet-4-6', contextLength: 222 }],
      },
    });
    const found = findModelMetadata('anthropic', 'claude-sonnet-4-6', cache);
    expect(found?.contextLength).toBe(111);
  });

  it('falls back to runtime cache when models-dev has no match', () => {
    const cache = makeCache({
      catalog: {},
      providerModels: {
        anthropic: [{ id: 'claude-sonnet-4-6', contextLength: 222 }],
      },
    });
    const found = findModelMetadata('anthropic', 'claude-sonnet-4-6', cache);
    expect(found?.contextLength).toBe(222);
  });

  it('returns null when neither source has the model', () => {
    expect(findModelMetadata('anthropic', 'missing', makeCache({}))).toBeNull();
  });
});
