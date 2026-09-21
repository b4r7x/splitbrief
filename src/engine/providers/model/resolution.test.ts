import { describe, expect, it } from 'vitest';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import {
  NULL_CACHE,
  findKnownModel,
  getEffectiveModelId,
  getModelsDevEntries,
  lookupModelsDevModel,
  lookupRuntimeModel,
  resolveExactModelsDevModel,
  resolveExactRuntimeModel,
  type ModelCacheAccessor,
} from './resolution.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';

describe('exact model resolution', () => {
  it('does not normalize case, aliases, snapshots, or provider-qualified IDs into one selection', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        'claude-code': [
          { id: 'claude-sonnet-4-6' },
          { id: 'claude-sonnet-4-6-20260201' },
          { id: 'anthropic/claude-sonnet-4-6' },
        ],
      },
    });

    expect(lookupRuntimeModel('claude-code', 'claude-sonnet-4-6', cache)?.id).toBe(
      'claude-sonnet-4-6',
    );
    expect(lookupRuntimeModel('claude-code', 'CLAUDE-SONNET-4-6', cache)).toBeNull();
    expect(lookupRuntimeModel('claude-code', 'claude-sonnet-4-6-20260201', cache)?.id).toBe(
      'claude-sonnet-4-6-20260201',
    );
    expect(lookupRuntimeModel('claude-code', 'anthropic/claude-sonnet-4-6', cache)?.id).toBe(
      'anthropic/claude-sonnet-4-6',
    );
  });

  it('uses only runner-admitted source entries instead of crossing into another provider catalog', () => {
    const catalog: ModelsDevCatalog = {
      ollama: {
        id: 'ollama',
        models: { 'claude-sonnet-5': { id: 'claude-sonnet-5' } },
      },
      openai: {
        id: 'openai',
        models: { 'claude-sonnet-5': { id: 'claude-sonnet-5' } },
      },
    };
    const cache = makeModelCacheAccessor({ catalog });

    const exact = resolveExactModelsDevModel({
      providerId: 'ollama',
      selectionId: 'claude-sonnet-5',
      cache,
    });

    expect(exact).toMatchObject({ kind: 'found', model: { providerId: 'ollama' } });
    expect(
      resolveExactModelsDevModel({
        providerId: 'ollama',
        selectionId: 'claude-sonnet-5',
        sourceProviderId: 'openai',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });
    expect(
      resolveExactModelsDevModel({
        providerId: 'claude-code',
        selectionId: 'claude-sonnet-5',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });
    expect(
      resolveExactModelsDevModel({
        providerId: 'claude-code',
        selectionId: 'claude-sonnet-5',
        sourceProviderId: 'openai',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });
  });

  it('returns no models.dev entries for a CLI tool id', () => {
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

    const entries = getModelsDevEntries('claude-code', makeModelCacheAccessor({ catalog }));

    expect(entries).toEqual([]);
  });

  it('returns models.dev entries for an api provider', () => {
    const catalog: ModelsDevCatalog = {
      ollama: {
        id: 'ollama',
        models: {
          'qwen3-coder:30b': { id: 'qwen3-coder:30b' },
          'qwen3-coder:480b': { id: 'qwen3-coder:480b' },
          'granite4:small': { id: 'granite4:small' },
        },
      },
    };

    const entries = getModelsDevEntries('ollama', makeModelCacheAccessor({ catalog }));

    expect(entries.map((entry) => [entry.providerId, entry.id])).toEqual([
      ['ollama', 'qwen3-coder:30b'],
      ['ollama', 'qwen3-coder:480b'],
      ['ollama', 'granite4:small'],
    ]);
  });

  it('keeps the configured selection byte-for-byte unless it means automatic', () => {
    expect(getEffectiveModelId('claude-code', 'opus')).toBe('opus');
    expect(getEffectiveModelId('claude-code', 'claude-fable-5-1[1m]')).toBe('claude-fable-5-1[1m]');
    expect(getEffectiveModelId('ollama', '  qwen3-coder:30b  ')).toBe('  qwen3-coder:30b  ');
    expect(getEffectiveModelId('ollama', 'auto')).toBe('qwen3-coder:30b');
    expect(getEffectiveModelId('ollama', '   ')).toBe('qwen3-coder:30b');
    // "Means automatic" is `normalizeConfiguredModel`'s answer, the same one the catalog lane and
    // the crew identity use — case-insensitive, and provider-aware for claude-code's legacy
    // `default`. This cascade used to compare the sentinel exactly and provider-blind, which left a
    // seat still carrying `default` resolving to a model literally named `default`: with the
    // `default` row deleted it then had no context window at all and budgeted at the 32,768
    // fallback while an identical `auto` seat got its real window (REQ-D09).
    expect(getEffectiveModelId('ollama', 'AUTO')).toBe('qwen3-coder:30b');
    expect(getEffectiveModelId('claude-code', 'default')).toBe(
      getEffectiveModelId('claude-code', 'auto'),
    );
  });

  it('uses runner aliases as explicit metadata relationships without rewriting the alias', () => {
    expect(findKnownModel('claude-code', 'opus')?.catalogModelId).toBe('claude-opus-5');
    expect(findKnownModel('claude-code', 'OPUS')).toBeUndefined();
    expect(getEffectiveModelId('claude-code', 'opus')).toBe('opus');
  });

  // SPEC-D7: only the models.dev lookup reads through a `[1m]` window suffix. `findKnownModel` is
  // a `.find` over aliases declared plain-first, so a suffix-blind comparator here would answer
  // `opus[1m]` with the `opus` row and hide the 1M sibling's own facts. Extend the list when the
  // claude-alias sprint adds `fable[1m]`.
  it.each(['opus', 'opus[1m]', 'sonnet', 'sonnet[1m]'])(
    'answers the claude-code alias %s with the bundled row of that exact name',
    (alias) => {
      expect(findKnownModel('claude-code', alias)?.name).toBe(alias);
    },
  );

  it('resolves a window-suffixed selection onto the models.dev row it strips to', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        ollama: {
          id: 'ollama',
          models: {
            'claude-fable-5-1': {
              id: 'claude-fable-5-1',
              name: 'Claude Fable 5.1',
              limit: { context: 1_000_000 },
              release_date: '2026-09-01',
            },
          },
        },
      },
    });

    expect(
      resolveExactModelsDevModel({
        providerId: 'ollama',
        selectionId: 'claude-fable-5-1[1m]',
        cache,
      }),
    ).toMatchObject({
      kind: 'found',
      model: { id: 'claude-fable-5-1', contextLength: 1_000_000, releaseDate: '2026-09-01' },
    });
    expect(
      resolveExactModelsDevModel({
        providerId: 'ollama',
        selectionId: 'claude-fable-5[1m]',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });
    expect(
      resolveExactModelsDevModel({
        providerId: 'claude-code',
        selectionId: 'claude-fable-5-1[1m]',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });
  });

  // This lookup feeds `resolveRunnerContextWindow` and the escalation budget, so the window it
  // reports must stay sourceable — it is the matched models.dev row's own published number.
  // Nothing here may synthesise a window from the suffix string.
  it('reports the matched models.dev window for a suffixed selection, never a synthesised one', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        ollama: {
          id: 'ollama',
          models: {
            'claude-haiku-4-5': {
              id: 'claude-haiku-4-5',
              name: 'Claude Haiku 4.5',
              limit: { context: 200_000 },
              release_date: '2025-10-01',
            },
          },
        },
      },
    });

    expect(
      resolveExactModelsDevModel({
        providerId: 'ollama',
        selectionId: 'claude-haiku-4-5[1m]',
        cache,
      }),
    ).toMatchObject({
      kind: 'found',
      model: { id: 'claude-haiku-4-5', contextLength: 200_000, releaseDate: '2025-10-01' },
    });
    expect(
      resolveExactModelsDevModel({
        providerId: 'ollama',
        selectionId: 'claude-haiku-4-5',
        cache,
      }),
    ).toMatchObject({ kind: 'found', model: { contextLength: 200_000 } });
    expect(
      resolveExactModelsDevModel({
        providerId: 'claude-code',
        selectionId: 'claude-haiku-4-5[1m]',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });
  });

  it('reports owner-ambiguous exact runtime IDs instead of choosing or normalizing one', () => {
    const cache = makeModelCacheAccessor({
      providerModels: {
        opencode: [
          { id: 'provider/model-x', providerId: 'vendor-a' },
          { id: 'provider/model-x', providerId: 'vendor-b' },
        ],
      },
    });

    const result = resolveExactRuntimeModel({
      providerId: 'opencode',
      selectionId: 'provider/model-x',
      cache,
    });

    expect(result).toMatchObject({
      kind: 'ambiguous',
      models: [
        { id: 'provider/model-x', providerId: 'vendor-a' },
        { id: 'provider/model-x', providerId: 'vendor-b' },
      ],
    });
  });

  it('treats an explicit role-scoped absence as authoritative instead of borrowing generic provider models', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => [{ id: 'generic-provider-model' }],
      getScopedProviderRuntime: () => null,
    };

    expect(
      resolveExactRuntimeModel({
        providerId: 'ollama',
        selectionId: 'generic-provider-model',
        role: 'planner',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });
  });

  it('resolves native CLI models from the tool row for every seat and never falls back through it', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => [{ id: 'generic-must-not-leak' }],
      getCliCatalogRuntime: () => ({
        connection: { tool: 'codex', contextKey: 'codex-exact-context' },
        state: 'fresh',
        models: [{ id: 'codex-listed-model' }],
        fetchedAt: 1,
        validatedAt: 1,
      }),
    };

    for (const role of ['planner', 'implementer', 'reviewer'] as const) {
      expect(
        resolveExactRuntimeModel({
          providerId: 'codex',
          selectionId: 'codex-listed-model',
          role,
          cache,
        }),
      ).toMatchObject({ kind: 'found', model: { id: 'codex-listed-model' } });
      expect(
        resolveExactRuntimeModel({
          providerId: 'codex',
          selectionId: 'generic-must-not-leak',
          role,
          cache,
        }),
      ).toEqual({ kind: 'not-found' });
    }
  });

  it('treats an authoritative empty CLI catalog as absence rather than borrowing provider memory', () => {
    const cache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => [{ id: 'generic-must-not-leak' }],
      getCliCatalogRuntime: () => null,
    };

    expect(
      resolveExactRuntimeModel({
        providerId: 'codex',
        selectionId: 'generic-must-not-leak',
        role: 'planner',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });

    const legacyCache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: () => [{ id: 'generic-must-not-leak' }],
      getCliCatalogRuntime: () => undefined,
    };

    expect(
      resolveExactRuntimeModel({
        providerId: 'codex',
        selectionId: 'generic-must-not-leak',
        role: 'planner',
        cache: legacyCache,
      }),
    ).toEqual({ kind: 'found', model: { id: 'generic-must-not-leak' } });
  });
});

describe('metadata overlay', () => {
  it('keeps runtime fields authoritative and fills only missing fields from an exact models.dev match', () => {
    const catalog: ModelsDevCatalog = {
      ollama: {
        id: 'ollama',
        models: {
          'claude-sonnet-4-6': {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            cost: { input: 3, output: 15 },
            limit: { context: 1_000_000 },
            release_date: '2026-01-10',
          },
        },
      },
    };
    const cache = makeModelCacheAccessor({
      catalog,
      providerModels: {
        ollama: [
          {
            id: 'claude-sonnet-4-6',
            providerId: 'ollama',
            displayName: 'Native Sonnet',
            contextLength: 32_768,
            pricingInput: 8,
          },
        ],
      },
    });

    expect(lookupRuntimeModel('ollama', 'claude-sonnet-4-6', cache)).toMatchObject({
      id: 'claude-sonnet-4-6',
      displayName: 'Native Sonnet',
      contextLength: 32_768,
      pricingInput: 8,
    });
    expect(lookupModelsDevModel('ollama', 'claude-sonnet-4-6', cache)).toMatchObject({
      id: 'claude-sonnet-4-6',
      pricingOutput: 15,
      releaseDate: '2026-01-10',
    });
  });

  it('keeps explicit runtime false capability facts over exact public metadata', () => {
    const cache = makeModelCacheAccessor({
      catalog: {
        ollama: {
          id: 'ollama',
          models: {
            'native-false-capabilities': {
              id: 'native-false-capabilities',
              modalities: { input: ['text', 'image'] },
              tool_call: true,
              reasoning: true,
            },
          },
        },
      },
      providerModels: {
        ollama: [
          {
            id: 'native-false-capabilities',
            providerId: 'ollama',
            supportsImages: false,
            supportsToolCalls: false,
            supportsReasoning: false,
          },
        ],
      },
    });

    expect(lookupRuntimeModel('ollama', 'native-false-capabilities', cache)).toMatchObject({
      supportsImages: false,
      supportsToolCalls: false,
      supportsReasoning: false,
    });
  });

  it('does not use a nearly matching public ID as metadata for a runtime row', () => {
    const catalog: ModelsDevCatalog = {
      ollama: {
        id: 'ollama',
        models: {
          'claude-sonnet-4.6': {
            id: 'claude-sonnet-4.6',
            name: 'Wrong Punctuation',
          },
        },
      },
    };
    const cache = makeModelCacheAccessor({
      catalog,
      providerModels: { ollama: [{ id: 'claude-sonnet-4-6', contextLength: 64_000 }] },
    });

    expect(lookupRuntimeModel('ollama', 'claude-sonnet-4-6', cache)).toEqual({
      id: 'claude-sonnet-4-6',
      contextLength: 64_000,
    });
    expect(
      resolveExactModelsDevModel({
        providerId: 'ollama',
        selectionId: 'claude-sonnet-4-6',
        cache,
      }),
    ).toEqual({ kind: 'not-found' });
  });
});

describe('NULL_CACHE', () => {
  it('has no public or runtime model membership', () => {
    expect(NULL_CACHE.getModelsDevCatalog()).toBeNull();
    expect(NULL_CACHE.getProviderModels('claude-code')).toBeNull();
    expect(lookupModelsDevModel('claude-code', 'claude-sonnet-4-6', NULL_CACHE)).toBeNull();
  });
});
